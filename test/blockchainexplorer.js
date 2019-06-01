'use strict';

var _ = require("lodash");
var sinon = require("sinon");
var crypto = require("crypto");

var blockchainExplorerMock = {
};

blockchainExplorerMock.getUtxos = function(addresses, asset, cb) {
  var selected = [];
  blockchainExplorerMock.utxos.forEach(function(utxo) {
    if (addresses.includes(utxo.address)) {
      selected.push(utxo);
    }
  });
  return cb(null, selected);
};

blockchainExplorerMock.getBalance = function(addresses, asset, cb) {
  var balances = {};
  balances['base'] = { stable: 0, pending: 0, stable_outputs_count: 0, pending_outputs_count: 0 };

  blockchainExplorerMock.utxos.forEach(function(utxo) {
    if (addresses.includes(utxo.address) && !utxo.is_spent) {
      balances[utxo.asset || 'base'][utxo.stable ? 'stable' : 'pending'] += utxo.amount;
      balances[utxo.asset || 'base'][utxo.stable ? 'stable_outputs_count' : 'pending_outputs_count'] += 1;
    }
  });

  return cb(null, balances);
};

blockchainExplorerMock.setUtxo = function(address, amount) {
  var utxo = {
    unit: crypto.createHash("sha256").update(Math.random().toString(), "utf8").digest("base64"),
    message_index: _.random(0, 10),
    output_index: _.random(0, 10),
    asset: null,
    amount: amount,
    stable: true,
    address: address.address,
    path: address.path,
    definition: address.definition,
    signingPaths: address.signingPaths,
    walletId: address.walletId,
    is_spent: false,
  };
  if (!blockchainExplorerMock.utxos) blockchainExplorerMock.utxos = [];
  blockchainExplorerMock.utxos.push(utxo);

  return utxo;
};

blockchainExplorerMock.broadcastJoint = sinon.stub().callsArgWith(1, null, null);


blockchainExplorerMock.getAddressUtxos = function(address,  cb) {
  var selected = _.filter(blockchainExplorerMock.utxos, function(utxo) {
    return _.includes(address, utxo.address);
  });
 
  return cb(null, _.cloneDeep(selected));
};

blockchainExplorerMock.setHistory = function(txs) {
  blockchainExplorerMock.txHistory = txs;
};

blockchainExplorerMock.getTransaction = function(txid, cb) {
  return cb();
};

blockchainExplorerMock.getTransactions = function(wallet, startBlock, cb) {
  var list = [].concat(blockchainExplorerMock.txHistory);
  list = _.filter(list, (x) => { return x.height >= startBlock || x.height == -1; } );
  return cb(null, list);
};

blockchainExplorerMock.getAddressActivity = function(address, cb) {
  var activeAddresses = _.map(blockchainExplorerMock.utxos || [], 'address');
  return cb(null, _.includes(activeAddresses, address));
};

blockchainExplorerMock.reset = function() {
  blockchainExplorerMock.utxos = [];
  blockchainExplorerMock.txHistory = [];
};

module.exports = blockchainExplorerMock;
