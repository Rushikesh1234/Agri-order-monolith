function doGet(e) {
  if (e.parameter.view === "worker") {
    return HtmlService.createHtmlOutputFromFile('worker')
        .setTitle('Worker Dashboard')
        .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }

  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('MyFarmer Naturals Pune - Order Form')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0');
}

// Fetch items grouped by category with dynamic config type mappings
function getInventory() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Inventory");
  var data = sheet.getDataRange().getValues();
  var inventory = {};
  
  for (var i = 1; i < data.length; i++) {
    var category = data[i][0];
    if (!category) continue;
    
    var item = data[i][1];
    var price = data[i][2];
    var baseUnit = data[i][3];
    var configType = data[i][4] ? data[i][4].toString().trim() : "By Count (pc/bottle)";
    
    if (!inventory[category]) {
      inventory[category] = [];
    }
    inventory[category].push({
      name: item, 
      price: price, 
      baseUnit: baseUnit,
      configType: configType
    });
  }
  return inventory;
}

// Save order to Sheet & update Item Sales summaries dynamically (with Revenue)
function processOrder(customerData, cartItems, grandTotal) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  
  var orderSheet = ss.getSheetByName("Orders");
  var orderSummary = cartItems.map(function(item) {
    return item.name + " (" + item.displayUnit + ") x " + item.qty + " - " + item.total;
  }).join("\n");
  
  orderSheet.appendRow([
    new Date(),
    customerData.name,
    "'" + customerData.phone,
    customerData.address,
    orderSummary,
    grandTotal,
    "Pending"
  ]);
  
  try {
    var summarySheet = ss.getSheetByName("ItemSalesSummary");
    var summaryData = summarySheet.getDataRange().getValues();
    
    var itemRowMap = {};
    for (var r = 1; r < summaryData.length; r++) {
      var key = summaryData[r][0] + "|||" + summaryData[r][1]; // ItemName|||UnitType
      itemRowMap[key] = r + 1; // Store actual spreadsheet row number
    }
    
    cartItems.forEach(function(item) {
      var itemName = item.name;
      var rawUnit = item.displayUnit ? item.displayUnit.toLowerCase().trim() : "";
      var orderQty = parseFloat(item.qty) || 0;
      
      var itemLineRevenue = parseFloat(item.total.toString().replace(/[^0-9.]/g, '')) || 0;
      
      var calculatedQty = orderQty;
      var finalUnitLabel = "Count (pc/bundle/jar)";
      
      if (rawUnit.includes("kg") || rawUnit.includes("कियलो")) {
        calculatedQty = orderQty;
        finalUnitLabel = "kg";
      } else if (rawUnit.includes("gm") || rawUnit.includes("ग्राम")) {
        var numericWeight = parseFloat(rawUnit.replace(/[^0-9.]/g, ''));
        if (!numericWeight || isNaN(numericWeight)) { numericWeight = 250; }
        calculatedQty = (numericWeight * orderQty) / 1000;
        finalUnitLabel = "kg";
      } else {
        calculatedQty = orderQty;
        finalUnitLabel = "Count (pc/bundle/jar)";
      }
      
      var mapKey = itemName + "|||" + finalUnitLabel;
      
      if (itemRowMap[mapKey]) {
        var targetRow = itemRowMap[mapKey];
        
        var qtyCell = summarySheet.getRange(targetRow, 3);
        var currentQty = parseFloat(qtyCell.getValue()) || 0;
        qtyCell.setValue(currentQty + calculatedQty);
        
        var revCell = summarySheet.getRange(targetRow, 4);
        var currentRev = parseFloat(revCell.getValue()) || 0;
        revCell.setValue(currentRev + itemLineRevenue);
        
      } else {
        summarySheet.appendRow([itemName, finalUnitLabel, calculatedQty, itemLineRevenue]);
        
        summaryData = summarySheet.getDataRange().getValues();
        itemRowMap[mapKey] = summaryData.length;
      }
    });
  } catch (err) {
    Logger.log("Item Summary Revenue Tracking Error: " + err.toString());
  }
  
  return true;
}

// Read active orders cleanly - ONLY loads "Pending" orders now
function getWorkerOrders() {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Orders");
    var data = sheet.getDataRange().getValues();
    var ordersList = [];
    
    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      
      if (!row[1] || !row[6]) continue; 
      
      var currentStatus = row[6].toString().trim();
      
      // Changed from !== "Packed" to STRICTLY === "Pending" so Cancelled entries vanish instantly
      if (currentStatus === "Pending") { 
        ordersList.push({
          rowNumber: i + 1,
          timestamp: row[0] ? row[0].toString() : "",
          name: row[1].toString(),
          phone: row[2].toString(),
          address: row[3].toString(),
          items: row[4].toString(),
          total: row[5].toString(),
          status: currentStatus
        });
      }
    }
    return ordersList;
  } catch (err) {
    Logger.log("Error details: " + err.toString());
    return [];
  }
}

// Handles state updates and automatically subtracts metrics on active cancellations
function updateOrderStatus(rowNumber, customStatus) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Orders");
  var finalStatus = (customStatus === "Cancelled") ? "Cancelled" : "Packed";
  
  if (customStatus === "Cancelled") {
    var previousStatus = sheet.getRange(rowNumber, 7).getValue().toString().trim();
    
    // Safety check: Only deduct values if the target row wasn't already marked cancelled
    if (previousStatus !== "Cancelled") {
      var orderSummary = sheet.getRange(rowNumber, 5).getValue().toString();
      deductFromSummary(ss, orderSummary);
    }
  }
  
  sheet.getRange(rowNumber, 7).setValue(finalStatus);
  return true;
}

// Helper engine that parses text maps backwards to reverse totals cleanly
function deductFromSummary(ss, orderSummary) {
  try {
    var summarySheet = ss.getSheetByName("ItemSalesSummary");
    if (!summarySheet) return;
    
    var summaryData = summarySheet.getDataRange().getValues();
    var itemRowMap = {};
    for (var r = 1; r < summaryData.length; r++) {
      var key = summaryData[r][0] + "|||" + summaryData[r][1];
      itemRowMap[key] = r + 1;
    }
    
    var lines = orderSummary.split("\n");
    lines.forEach(function(line) {
      if (!line.trim()) return;
      
      // Step A: Parse out the revenue string boundary
      var parts = line.split(" - ");
      if (parts.length < 2) return;
      var totalStr = parts.pop();
      var itemPart = parts.join(" - ");
      
      // Step B: Parse out line item quantities
      var qtyParts = itemPart.split(" x ");
      if (qtyParts.length < 2) return;
      var qtyStr = qtyParts.pop();
      var detailsPart = qtyParts.join(" x ");
      
      // Step C: Isolate item names from their descriptive bracket metrics
      var openParen = detailsPart.lastIndexOf(" (");
      var closeParen = detailsPart.lastIndexOf(")");
      if (openParen === -1 || closeParen === -1) return;
      
      var itemName = detailsPart.substring(0, openParen).trim();
      var rawUnit = detailsPart.substring(openParen + 2, closeParen).toLowerCase().trim();
      
      var orderQty = parseFloat(qtyStr) || 0;
      var itemLineRevenue = parseFloat(totalStr.replace(/[^0-9.]/g, '')) || 0;
      
      var calculatedQty = orderQty;
      var finalUnitLabel = "Count (pc/bundle/jar)";
      
      if (rawUnit.includes("kg") || rawUnit.includes("कियलो")) {
        calculatedQty = orderQty;
        finalUnitLabel = "kg";
      } else if (rawUnit.includes("gm") || rawUnit.includes("ग्राम")) {
        var numericWeight = parseFloat(rawUnit.replace(/[^0-9.]/g, ''));
        if (!numericWeight || isNaN(numericWeight)) { numericWeight = 250; }
        calculatedQty = (numericWeight * orderQty) / 1000;
        finalUnitLabel = "kg";
      } else {
        calculatedQty = orderQty;
        finalUnitLabel = "Count (pc/bundle/jar)";
      }
      
      var mapKey = itemName + "|||" + finalUnitLabel;
      
      if (itemRowMap[mapKey]) {
        var targetRow = itemRowMap[mapKey];
        
        // Subtract Quantity cell contents precisely
        var qtyCell = summarySheet.getRange(targetRow, 3);
        var currentQty = parseFloat(qtyCell.getValue()) || 0;
        qtyCell.setValue(Math.max(0, currentQty - calculatedQty));
        
        // Subtract Financial revenue parameters precisely
        var revCell = summarySheet.getRange(targetRow, 4);
        var currentRev = parseFloat(revCell.getValue()) || 0;
        revCell.setValue(Math.max(0, currentRev - itemLineRevenue));
      }
    });
  } catch (err) {
    Logger.log("Deduction Core Engine Error: " + err.toString());
  }
}
