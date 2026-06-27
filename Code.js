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
      var key = summaryData[r][0] + "|||" + summaryData[r][1];
      itemRowMap[key] = r + 1;
    }
    
    cartItems.forEach(function(item) {
      var itemName = item.name;
      var rawUnit = item.displayUnit ? item.displayUnit.toLowerCase().trim() : "";
      var itemLineRevenue = parseFloat(item.total.toString().replace(/[^0-9.]/g, '')) || 0;
      
      var calculatedQty = 0;
      var finalUnitLabel = "Count (pc/bundle/jar)";
      
      // Algorithmic parse that loops through complex combined string types (e.g. "1 kg 500 gm")
      if (rawUnit.includes("kg") || rawUnit.includes("gm") || rawUnit.includes("कियलो") || rawUnit.includes("ग्राम")) {
        finalUnitLabel = "kg";
        var totalParsedKg = 0;
        
        // Match specific structural units anywhere in the display text
        var kgMatch = rawUnit.match(/([0-9.]+)\s*(kg|कियलो)/);
        var gmMatch = rawUnit.match(/([0-9.]+)\s*(gm|ग्राम)/);
        
        if (kgMatch) { totalParsedKg += parseFloat(kgMatch[1]) || 0; }
        if (gmMatch) { totalParsedKg += (parseFloat(gmMatch[1]) || 0) / 1000; }
        
        calculatedQty = totalParsedKg;
      } else {
        calculatedQty = parseFloat(item.qty) || 0;
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

function getWorkerOrders() {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Orders");
    var data = sheet.getDataRange().getValues();
    var ordersList = [];
    
    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      if (!row[1] || !row[6]) continue; 
      var currentStatus = row[6].toString().trim();
      
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

function updateOrderStatus(rowNumber, customStatus) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Orders");
  var finalStatus = (customStatus === "Cancelled") ? "Cancelled" : "Packed";
  
  if (customStatus === "Cancelled") {
    var previousStatus = sheet.getRange(rowNumber, 7).getValue().toString().trim();
    if (previousStatus !== "Cancelled") {
      var orderSummary = sheet.getRange(rowNumber, 5).getValue().toString();
      deductFromSummary(ss, orderSummary);
    }
  }
  sheet.getRange(rowNumber, 7).setValue(finalStatus);
  return true;
}

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
      
      var parts = line.split(" - ");
      if (parts.length < 2) return;
      var totalStr = parts.pop();
      var itemPart = parts.join(" - ");
      
      var qtyParts = itemPart.split(" x ");
      if (qtyParts.length < 2) return;
      var qtyStr = qtyParts.pop();
      var detailsPart = qtyParts.join(" x ");
      
      var openParen = detailsPart.lastIndexOf(" (");
      var closeParen = detailsPart.lastIndexOf(")");
      if (openParen === -1 || closeParen === -1) return;
      
      var itemName = detailsPart.substring(0, openParen).trim();
      var rawUnit = detailsPart.substring(openParen + 2, closeParen).toLowerCase().trim();
      
      var itemLineRevenue = parseFloat(totalStr.replace(/[^0-9.]/g, '')) || 0;
      var calculatedQty = 0;
      var finalUnitLabel = "Count (pc/bundle/jar)";
      
      if (rawUnit.includes("kg") || rawUnit.includes("gm") || rawUnit.includes("कियलो") || rawUnit.includes("ग्राम")) {
        finalUnitLabel = "kg";
        var totalParsedKg = 0;
        
        var kgMatch = rawUnit.match(/([0-9.]+)\s*(kg|कियलो)/);
        var gmMatch = rawUnit.match(/([0-9.]+)\s*(gm|ग्राम)/);
        
        if (kgMatch) { totalParsedKg += parseFloat(kgMatch[1]) || 0; }
        if (gmMatch) { totalParsedKg += (parseFloat(gmMatch[1]) || 0) / 1000; }
        
        calculatedQty = totalParsedKg;
      } else {
        calculatedQty = parseFloat(qtyStr) || 0;
        finalUnitLabel = "Count (pc/bundle/jar)";
      }
      
      var mapKey = itemName + "|||" + finalUnitLabel;
      
      if (itemRowMap[mapKey]) {
        var targetRow = itemRowMap[mapKey];
        var qtyCell = summarySheet.getRange(targetRow, 3);
        var currentQty = parseFloat(qtyCell.getValue()) || 0;
        qtyCell.setValue(Math.max(0, currentQty - calculatedQty));
        
        var revCell = summarySheet.getRange(targetRow, 4);
        var currentRev = parseFloat(revCell.getValue()) || 0;
        revCell.setValue(Math.max(0, currentRev - itemLineRevenue));
      }
    });
  } catch (err) {
    Logger.log("Deduction Core Engine Error: " + err.toString());
  }
}
