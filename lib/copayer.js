'use strict';

var $ = require('preconditions').singleton();
var _ = require('lodash');

var Common = require('./common');
var Constants = Common.Constants;
var Utils = Common.Utils;

var FIELDS = [
  'account',                 // account index of this copayer
  'copayerId',               // copayer id
  'copayerName',             // copayer name
  'xPubKey',                 // this copayer's xpubkey

  // this copayer's wallet
  'walletId',                // wallet id
  'walletName',              // wallet name
  'm',                       // required copayers
  'n',                       // total copayers
  'publicKeyRing',           // [{xPubKey, requestPubKey}] of all copayers
  'walletPrivKey',           // used to join the wallet, store in the customdata in the server
  'sharedEncryptingKey',     // used to encrypt message for copayers in the wallet, derived from walletPrivKey
  'addressType',             // address type
];

function Copayer() {
  this.version = 1;
  this.account = 0;
};

Copayer.create = function(deviceId, account) {
  $.shouldBeNumber(account);

  var x = new Copayer();
  x.account = account;
  x._expand(deviceId);

  return x;
};

Copayer.fromExtendedPublicKey = function(deviceId, xPubKey, account, opts) {
  $.shouldBeNumber(account);
  opts = opts || {};

  var x = new Copayer();
  x.xPubKey = xPubKey;
  x.account = account;

  if (opts.walletPrivKey) {
    x.addWalletPrivateKey(opts.walletPrivKey);
  }

  x._expand(deviceId);
  return x;
};

Copayer.prototype._expand = function(deviceId) {
  $.checkState(this.xPubKey);

  this.copayerId = Utils.xPubToCopayerId(this.xPubKey);
  this.publicKeyRing = [{
    xPubKey: this.xPubKey,
    requestPubKey: this.requestPubKey,
    deviceId: deviceId,
    account: this.account,
  }];
};

Copayer.fromObj = function(obj) {
  var x = new Copayer();

  _.each(FIELDS, function(k) {
    x[k] = obj[k];
  });

  x.account = x.account || 0;
  x.addressType = x.addressType || Constants.ADDRESS_TYPES.NORMAL;

  $.checkState(x.xPubKey, "invalid input");
  return x;
};

Copayer.prototype.toObj = function() {
  var self = this;

  var x = {};
  _.each(FIELDS, function(k) {
    x[k] = self[k];
  });
  return x;
};

Copayer.prototype.addWalletPrivateKey = function(walletPrivKey) {
  this.walletPrivKey = walletPrivKey;
  this.sharedEncryptingKey = Utils.privateKeyToAESKey(walletPrivKey);
};

Copayer.prototype.addWalletInfo = function(deviceId, walletId, walletName, m, n, requestPubKey, copayerName) {
  this.walletId = walletId;
  this.walletName = walletName;
  this.m = m;
  this.n = n;

  if (copayerName)
    this.copayerName = copayerName;

  if (n == 1)
    this.addressType = Constants.ADDRESS_TYPES.NORMAL;
  else
    this.addressType = Constants.ADDRESS_TYPES.SHARED;

  if (n == 1) {
    this.addPublicKeyRing([{
      xPubKey: this.xPubKey,
      requestPubKey: requestPubKey,
      deviceId: deviceId,
      account: this.account
    }]);
  }
};

Copayer.prototype.hasWalletInfo = function() {
  return !!this.walletId;
};

Copayer.prototype.addPublicKeyRing = function(publicKeyRing) {
  this.publicKeyRing = _.clone(publicKeyRing);
};

Copayer.prototype.isComplete = function() {
  if (!this.m || !this.n) return false;
  if (!this.publicKeyRing || this.publicKeyRing.length != this.n) return false;
  return true;
};

module.exports = Copayer;
