'use strict';

var _ = require("lodash");
var $ = require("preconditions").singleton();
var mongodb = require("mongodb");
var request = require("supertest");
var sinon = require("sinon");
var chai = require("chai");
chai.config.includeStack = true;
var should = chai.should();

var async = require("async");
var crypto = require("crypto");

var config = require("./test-config");
var Client = require("../lib");
var Common = require("../lib/common");
var ObjectHash = Common.ObjectHash;
var ObjectLength = Common.ObjectLength;
var Utils = Common.Utils;

var blockchainExplorer = require("./blockchainexplorer");


var helpers = {};

helpers.newDb = (extra, cb) => {
  extra = extra || '';
  mongodb.MongoClient.connect(config.mongoDb.uri + extra, function(err, in_db) {
    if (err) return cb(err);
    in_db.dropDatabase(function(err) {
      return cb(err, in_db);
    });
  });
}

helpers.newClient = function(app) {
  $.checkArgument(app);
  return new Client({
    baseUrl: '/ows/api',
    request: request(app),
  });
};

helpers.stubRequest = function(err, res) {
  var request = {
    accept: sinon.stub(),
    set: sinon.stub(),
    query: sinon.stub(),
    send: sinon.stub(),
    timeout: sinon.stub(),
    end: sinon.stub().yields(err, res),
  };
  var reqFactory = _.reduce(['get', 'post', 'put', 'delete'], function(mem, verb) {
    mem[verb] = function(url) {
      return request;
    };
    return mem;
  }, {});

  return reqFactory;
};

helpers.createAndJoinWallet = function(clients, m, n, opts, cb) {
  if (_.isFunction(opts)) {
    cb = opts;
    opts = null;
  }

  opts = opts || {};

  var coin = opts.coin || 'obyte';
  var network = opts.network || 'livenet';

  clients[0].seedFromRandomWithMnemonic({
    coin: coin,
    network: network,
  });

  clients[0].createWallet('mywallet', 'creator', m, n, {
    coin: coin,
    network: network,
    singleAddress: !!opts.singleAddress,
  }, function(err, secret) {
    should.not.exist(err);

    if (n > 1) {
      should.exist(secret);
    }

    async.series([
      function(next) {
        async.each(_.range(1, n), function(i, cb) {
          clients[i].seedFromRandomWithMnemonic({
            coin: coin,
            network: network
          });
          clients[i].joinWallet(secret, 'copayer ' + i, {
            coin: coin
          }, cb);
        }, next);
      },
      function(next) {
        async.each(_.range(n), function(i, cb) {
          clients[i].openWallet(cb);
        }, next);
      },
    ],
    function(err) {
      should.not.exist(err);
      return cb({
        m: m,
        n: n,
        secret: secret,
      });
    });
  });
};

helpers.tamperResponse = function(clients, method, url, args, tamper, cb) {
  clients = [].concat(clients);
  // Use first client to get a clean response from server
  clients[0]._doRequest(method, url, args, false, function(err, result) {
    should.not.exist(err);
    tamper(result);
    // Return tampered data for every client in the list
    _.each(clients, function(client) {
      client._doRequest = sinon.stub().withArgs(method, url).yields(null, result);
    });
    return cb();
  });
};

helpers.generateUtxos = function(walletId, addressType, publicKeyRing, path, requiredSignatures, amounts) {
  var amounts = [].concat(amounts);
  var utxos = _.map(amounts, function(amount, i) {
    var address = Utils.deriveAddress(walletId, addressType, publicKeyRing, path, requiredSignatures, 'livenet');
    var utxo = blockchainExplorer.setUtxo(address, amount);
    return utxo;
  });

  return utxos;
};

helpers.stubHistory = function(txs) {
  blockchainExplorer.getTxHistory = function(addresses, opts, cb) {
    return cb(null, txs);
  };
};

helpers.createAndPublishTxProposal = function(client, opts, cb) {
  opts = helpers.composeJoint(opts);
  client.createTxProposal(opts, function(err, txp) {
    if (err) return cb(err);
    client.publishTxProposal({
      txp: txp
    }, cb);
  });
};

const lightProps = {
  parent_units: ['sJJWrBAwmecNQhIfl6wxf/J4h0/N7hxkon5TV/pFHBg='],
  last_stable_mc_ball: 'q/wze2Pn6uqKHjOtf4JSzc0zRkZAQVIIBVFSoQ6qRWQ=',
  last_stable_mc_ball_unit: 'BGHDWQ1kJwRRhkTRWpfTITbqdTSdfzjEdkLDKdZjqlg=',
  last_stable_mc_ball_mci: 4129364,
  witness_list_unit: 'J8QFgTLI+3EkuAxX+eL6a0q114PJ4h4EOAiHAzxUp24='
};

const hash_placeholder = "--------------------------------------------"; // 256 bits (32 bytes) base64: 44 bytes
const sig_placeholder = "----------------------------------------------------------------------------------------"; // 88 bytes

helpers.composeJoint = function (txOpts) {
  blockchainExplorer.utxos.should.not.be.empty;

  var utxo = blockchainExplorer.utxos.find(function(item) {
    return !item.is_spent;
  });
  utxo.is_spent = true;

  var objPaymentMessage = {
    app: "payment",
    payload_location: "inline",
    payload_hash: hash_placeholder,
    payload: {
      inputs: [{
        unit: utxo.unit,
        message_index: utxo.message_index,
        output_index: utxo.output_index
      }],
      outputs: txOpts.params.outputs
    }
  };

  objPaymentMessage.payload_hash = ObjectHash.getBase64Hash(objPaymentMessage.payload);

  var arrMessages = [];
  arrMessages.push(objPaymentMessage);

  var objUnit = {
    version: '1.0',
    alt: '1',
    witness_list_unit: lightProps.witness_list_unit,
    last_ball_unit: lightProps.last_stable_mc_ball_unit,
    last_ball: lightProps.last_stable_mc_ball,
    parent_units: lightProps.parent_units,
    messages: arrMessages,
    authors: [{
      address: utxo.address,
      authentifiers: {},
      definition: utxo.definition
    }]
  };

  objUnit.headers_commission = ObjectLength.getHeadersSize(objUnit);
  objUnit.payload_commission = ObjectLength.getTotalPayloadSize(objUnit);
  objUnit.timestamp = Math.round(Date.now()/1000);

  txOpts.unit = objUnit;
  txOpts.signingInfo = {};
  txOpts.signingInfo[utxo.address] = {
    walletId: utxo.walletId,
    path: utxo.path,
    signingPaths: utxo.signingPaths
  };
  txOpts.testRun = true;

  return txOpts;
}

helpers.toBytes = function(GB) {
  if (_.isArray(GB)) {
    return _.map(GB, helpers.toBytes);
  } else {
    return parseFloat((GB * 1e9).toPrecision(12));
  }
};

module.exports = helpers;
