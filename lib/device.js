'use strict';

var $ = require('preconditions').singleton();
var _ = require('lodash');

var Bitcore = require('bitcore-lib');
var Mnemonic = require('bitcore-mnemonic');
var sjcl = require('sjcl');

var Common = require('./common');
var Constants = Common.Constants;
var Utils = Common.Utils;
var Copayer = require('./copayer');

var FIELDS = [
  'coin',                    // coin name, default 'obyte'
  'network',                 // livenet or testnet
  'derivationStrategy',      // derivation strategy, default 'BIP44'

  'xPrivKey',                // extended private key
  'xPubKey',                 // extended public key
  'xPrivKeyEncrypted',       // encrypted extended private key

  'mnemonic',                // mnemonic words
  'mnemonicEncrypted',       // encrypted mnemonic words
  'mnemonicHasPassphrase',   // if has passphrase
  
  'requestPrivKey',          // request private key for server
  'requestPubKey',           // request public key server
  'personalEncryptingKey',   // derived from requestPrivKey

  'entropySource',           // for hardware wallet

  'deviceId',                // device address
  'devicePubKey',            // public key of hardened path m/1' for deviceId
  'copayers'                 // copayer(wallet) list in the device
];

function Device() {
  this.version = 1;
  this.coin = 'obyte';
  this.derivationStrategy = Constants.DERIVATION_STRATEGIES.BIP44;
};

function _checkCoin(coin) {
  if (!_.includes(['obyte'], coin)) throw new Error('Invalid coin');
};

function _checkNetwork(network) {
  if (!_.includes(['livenet', 'testnet'], network)) throw new Error('Invalid network');
};

Device.create = function(coin, network) {
  _checkCoin(coin);
  _checkNetwork(network);

  var x = new Device();

  x.coin = coin;
  x.network = network;
  x.xPrivKey = (new Bitcore.HDPrivateKey(network)).toString();
  x.copayers = [];
  x._expand();

  return x;
};

var wordsForLang = {
  'en': Mnemonic.Words.ENGLISH,
  'es': Mnemonic.Words.SPANISH,
  'ja': Mnemonic.Words.JAPANESE,
  'zh': Mnemonic.Words.CHINESE,
  'fr': Mnemonic.Words.FRENCH,
  'it': Mnemonic.Words.ITALIAN,
};

Device.createWithMnemonic = function(coin, network, passphrase, language) {
  _checkCoin(coin);
  _checkNetwork(network);
  if (!wordsForLang[language]) throw new Error('Unsupported language');

  var m = new Mnemonic(wordsForLang[language]);
  while (!Mnemonic.isValid(m.toString())) {
    m = new Mnemonic(wordsForLang[language])
  };
  var x = new Device();

  x.coin = coin;
  x.network = network;
  x.xPrivKey = m.toHDPrivateKey(passphrase, network).toString();
  x.mnemonic = m.phrase;
  x.mnemonicHasPassphrase = !!passphrase;
  x.copayers = [];
  x._expand();

  return x;
};

Device.fromExtendedPrivateKey = function(coin, xPrivKey, derivationStrategy) {
  _checkCoin(coin);
  $.checkArgument(_.includes(_.values(Constants.DERIVATION_STRATEGIES), derivationStrategy));

  var x = new Device();

  x.coin = coin;
  x.derivationStrategy = derivationStrategy;
  x.xPrivKey = xPrivKey;
  x.copayers = [];

  x._expand();
  return x;
};

Device.fromMnemonic = function(coin, network, words, passphrase, derivationStrategy) {
  _checkCoin(coin);
  _checkNetwork(network);
  $.checkArgument(_.includes(_.values(Constants.DERIVATION_STRATEGIES), derivationStrategy));

  var m = new Mnemonic(words);
  var x = new Device();

  x.coin = coin;
  x.network = network;
  x.derivationStrategy = derivationStrategy;
  x.xPrivKey = m.toHDPrivateKey(passphrase, network).toString();
  x.mnemonic = words;
  x.mnemonicHasPassphrase = !!passphrase;
  x.copayers = [];

  x._expand();
  return x;
};

/*
 * xPrivKey -> m/purpose'/coin'/account' -> Base Address Key
 *          -> m/1'                      -> Device Public Key
 * so, xPubKey is PublicKeyHD(xPrivKey.deriveChild("m/purpose'/coin'/account'"),
 * and devicePubKey is xPrivKey.deriveChild("m/1'").publicKey.
 *
 * For external sources, this derivation should be done before call fromExtendedPublicKey
 *
 * entropySource should be a HEX string containing pseudo-random data, that can
 * be deterministically derived from the xPrivKey, and should not be derived from xPubKey
 */
Device.fromExtendedPublicKey = function(coin, network, xPubKey, source, entropySourceHex, derivationStrategy, devicePubKey, opts) {
  _checkCoin(coin);
  _checkNetwork(network);
  $.checkArgument(entropySourceHex);
  $.checkArgument(_.includes(_.values(Constants.DERIVATION_STRATEGIES), derivationStrategy));

  opts = opts || {};

  var entropyBuffer = new Buffer(entropySourceHex, 'hex');
  //require at least 112 bits of entropy
  $.checkArgument(entropyBuffer.length >= 14, 'At least 112 bits of entropy are needed')

  var x = new Device();

  x.coin = coin;
  x.network = network;
  x.derivationStrategy = derivationStrategy;
  x.xPubKey = xPubKey;
  x.entropySource = Bitcore.crypto.Hash.sha256sha256(entropyBuffer).toString('hex');
  x.externalSource = source;
  x.devicePubKey = devicePubKey;
  x.copayers = [];

  x._expand();
  return x;
};

// Get network from extended private key or extended public key
Device._getNetworkFromExtendedKey = function(xKey) {
  $.checkArgument(xKey && _.isString(xKey));
  return xKey.charAt(0) == 't' ? 'testnet' : 'livenet';
};

Device.prototype._hashFromEntropy = function(prefix, length) {
  $.checkState(prefix);
  var b = new Buffer(this.entropySource, 'hex');
  var b2 = Bitcore.crypto.Hash.sha256hmac(b, new Buffer(prefix));
  return b2.slice(0, length);
};

Device.prototype._expand = function() {
  $.checkState(this.xPrivKey || (this.xPubKey && this.devicePubKey && this.entropySource));

  /* Derivation dependencies
   *
   * For signing software wallets with mnemonic
     mnemonic (+passphrase) -> xPrivKey -> deviceId
                                        -> requestPrivKey -> requestPubKey
                                        -> entropySource -> personalEncryptingKey

   * For signing software wallets without mnemonic
     xPrivKey -> deviceId
              -> requestPrivKey -> requestPubKey
              -> entropySource -> personalEncryptingKey

   * For RO software wallets  (MUST provide `entropySourceHex`)
      entropySourceHex -> (hashx2) entropySource 

      devicePubKey    -> deviceId
      entropySource   -> requestPrivKey -> requestPubKey
                      -> personalEncryptingKey

   * For Hardware wallets
      entropySourcePath -> (+hw xPub derivation) entropySource 

      devicePubKey    -> deviceId
      entropySource   -> requestPrivKey -> requestPubKey
                      -> personalEncryptingKey
  */

  var network = Device._getNetworkFromExtendedKey(this.xPrivKey || this.xPubKey);
  if (this.network) {
    $.checkState(this.network == network);
  } else {
    this.network = network;
  }

  if (this.xPrivKey) {
    var xPrivKey = new Bitcore.HDPrivateKey.fromString(this.xPrivKey);
    var deriveFn = _.bind(xPrivKey.deriveChild, xPrivKey);
    this.xPubKey = xPrivKey.hdPublicKey.toString();
    this.devicePubKey = deriveFn(Constants.PATHS.DEVICE_KEY).publicKey.toString();
  }

  if (this.entropySource) {
    // request keys from entropy (hardware wallets)
    var seed = this._hashFromEntropy('reqPrivKey', 32);
    var privKey = new Bitcore.PrivateKey(seed.toString('hex'), network);
    this.requestPrivKey = privKey.toString();
    this.requestPubKey = privKey.toPublicKey().toString();
  } else {
    // request keys derived from xPriv
    var requestDerivation = deriveFn(Constants.PATHS.REQUEST_KEY);
    this.requestPrivKey = requestDerivation.privateKey.toString();
    var pubKey = requestDerivation.publicKey;
    this.requestPubKey = pubKey.toString();
    this.entropySource = Bitcore.crypto.Hash.sha256(requestDerivation.privateKey.toBuffer()).toString('hex');
  }

  this.personalEncryptingKey = this._hashFromEntropy('personalKey', 16).toString('base64');
  this.deviceId = Utils.pubToDeviceId(this.devicePubKey);
};

Device.fromObj = function(obj) {
  var x = new Device();

  _.each(FIELDS, function(k) {
    x[k] = obj[k];
  });

  x.coin = x.coin || 'obyte';
  x.network = x.network || 'livenet';
  x.derivationStrategy = x.derivationStrategy || Constants.DERIVATION_STRATEGIES.BIP44;

  var copayers = [];
  _.map(x.copayers, function (copayer) {
    copayers.push(Copayer.fromObj(copayer));
  });
  x.copayers = copayers;

  // $.checkState(x.xPrivKey || x.xPrivKeyEncrypted, "invalid input");
  return x;
};

Device.prototype.toObj = function() {
  var self = this;

  var x = {};
  _.each(FIELDS, function(k) {
    x[k] = self[k];
  });
  return x;
};

Device.prototype.isPrivKeyEncrypted = function() {
  return (!!this.xPrivKeyEncrypted) && !this.xPrivKey;
};

Device.prototype.encryptPrivateKey = function(password, opts) {
  if (this.xPrivKeyEncrypted)
    throw new Error('Private key already encrypted');

  if (!this.xPrivKey)
    throw new Error('No private key to encrypt');


  this.xPrivKeyEncrypted = sjcl.encrypt(password, this.xPrivKey, opts);
  if (!this.xPrivKeyEncrypted)
    throw new Error('Could not encrypt');

  if (this.mnemonic)
    this.mnemonicEncrypted = sjcl.encrypt(password, this.mnemonic, opts);

  delete this.xPrivKey;
  delete this.mnemonic;
};

Device.prototype.decryptPrivateKey = function(password) {
  if (!this.xPrivKeyEncrypted)
    throw new Error('Private key is not encrypted');

  try {
    this.xPrivKey = sjcl.decrypt(password, this.xPrivKeyEncrypted);

    if (this.mnemonicEncrypted) {
      this.mnemonic = sjcl.decrypt(password, this.mnemonicEncrypted);
    }
    delete this.xPrivKeyEncrypted;
    delete this.mnemonicEncrypted;
  } catch (ex) {
    throw new Error('Could not decrypt');
  }
};

Device.prototype.getKeys = function(password) {
  var keys = {};

  if (this.isPrivKeyEncrypted()) {
    $.checkArgument(password, 'Private keys are encrypted, a password is needed');
    try {
      keys.xPrivKey = sjcl.decrypt(password, this.xPrivKeyEncrypted);

      if (this.mnemonicEncrypted) {
        keys.mnemonic = sjcl.decrypt(password, this.mnemonicEncrypted);
      }
    } catch (ex) {
      throw new Error('Could not decrypt');
    }
  } else {
    keys.xPrivKey = this.xPrivKey;
    keys.mnemonic = this.mnemonic;
  }
  return keys;
};

Device.prototype.canSign = function() {
  return (!!this.xPrivKey || !!this.xPrivKeyEncrypted);
};

Device.prototype.setNoSign = function() {
  delete this.xPrivKey;
  delete this.xPrivKeyEncrypted;
  delete this.mnemonic;
  delete this.mnemonicEncrypted;
};

Device.prototype.hasExternalSource = function() {
  return (typeof this.externalSource == "string");
};

Device.prototype.getExternalSourceName = function() {
  return this.externalSource;
};

Device.prototype.getMnemonic = function() {
  if (this.mnemonicEncrypted && !this.mnemonic) {
    throw new Error('Device are encrypted');
  }
  return this.mnemonic;
};

Device.prototype.clearMnemonic = function() {
  delete this.mnemonic;
  delete this.mnemonicEncrypted;
};

Device.prototype.getBaseDerivationPath = function(account) {
  $.shouldBeNumber(account);

  var purpose;
  switch (this.derivationStrategy) {
    case Constants.DERIVATION_STRATEGIES.BIP45:
      return "m/45'";
    case Constants.DERIVATION_STRATEGIES.BIP44:
      purpose = '44';
      break;
    case Constants.DERIVATION_STRATEGIES.BIP48:
      purpose = '48';
      break;
  }

  var coin = '0';
  if (this.network != 'livenet' ) {
    coin = '1';
  }

  return "m/" + purpose + "'/" + coin + "'/" + account + "'";
};

Device.prototype.getDerivedXPrivKey = function(account, password) {
  var path = this.getBaseDerivationPath(account);
  var xPrivKey = new Bitcore.HDPrivateKey(this.getKeys(password).xPrivKey, this.network);
  var deriveFn = _.bind(xPrivKey.deriveChild, xPrivKey);
  return deriveFn(path);
};

Device.prototype.getNewAccount = function() {
  var accounts = _.map(this.copayers, function (item) {
    return item.account;
  });

  if (_.isEmpty(accounts)) {
    return 0;
  } else {
    var account = Math.max.apply(null, accounts);
    return account+1;
  }
}

Device.prototype.getCopayer = function(account) {
  account = account || 0;

  var accounts = _.map(this.copayers, function (item) {
    return item.account;
  });

  if (account in accounts) {
    var ind = accounts.indexOf(account);
    return this.copayers[ind];
  } else {
    return null;
  }
}

Device.prototype.addCopayer = function(account, opts) {
  opts = opts || {};

  var accounts = _.map(this.copayers, function (item) {
    return item.account;
  });

  if (account in accounts) {
    console.log('duplicate account');
    return null;
  } else {
    var xPriv = this.getDerivedXPrivKey(account, opts.password);
    var xPub = xPriv.hdPublicKey.toString();
    var copayer = Copayer.fromExtendedPublicKey(this.deviceId, xPub, account, opts);
    this.copayers.push(copayer);
    return copayer;
  }
}


module.exports = Device;
