'use strict';

var _ = require('lodash');
var $ = require('preconditions').singleton();
var util = require('util');
var async = require('async');
var events = require('events');
var Bitcore = require('bitcore-lib');
var Mnemonic = require('bitcore-mnemonic');
var sjcl = require('sjcl');
var url = require('url');
var querystring = require('querystring');
var Stringify = require('json-stable-stringify');

var request = require('superagent');

var Common = require('./common');
var Constants = Common.Constants;
var Defaults = Common.Defaults;
var Utils = Common.Utils;
var ObjectHash = Common.ObjectHash;
var EcdsaSig = Common.EcdsaSig;
var ObjectLength = Common.ObjectLength;

var log = require('./log');
var Device = require('./device');
var Copayer = require('./copayer');
var Verifier = require('./verifier');
var Package = require('../package.json');
var Errors = require('./errors');


/**
 * @desc ClientAPI constructor.
 *
 * @param {Object} opts
 * @constructor
 */
function API(opts) {
  opts = opts || {};

  this.request = opts.request || request;
  this.baseUrl = opts.baseUrl || Defaults.BASE_URL;
  this.timeout = opts.timeout || 50000;
  this.logLevel = opts.logLevel || 'silent';
  this.supportStaffWalletId = opts.supportStaffWalletId;

  log.setLevel(this.logLevel);
};
util.inherits(API, events.EventEmitter);

API.privateKeyEncryptionOpts = {
  iter: 10000
};

API.prototype.initialize = function(opts, cb) {
  $.checkState(this.copayer);

  var self = this;

  self.notificationIncludeOwn = !!opts.notificationIncludeOwn;
  self._initNotifications(opts);
  return cb();
};

API.prototype.dispose = function(cb) {
  var self = this;
  self._disposeNotifications();
  self._logout(cb);
};

API.prototype._fetchLatestNotifications = function(interval, cb) {
  var self = this;

  cb = cb || function() {};

  var opts = {
    lastNotificationId: self.lastNotificationId,
    includeOwn: self.notificationIncludeOwn,
  };

  if (!self.lastNotificationId) {
    opts.timeSpan = interval + 1;
  }

  self.getNotifications(opts, function(err, notifications) {
    if (err) {
      log.warn('Error receiving notifications.');
      log.debug(err);
      return cb(err);
    }
    if (notifications.length > 0) {
      self.lastNotificationId = _.last(notifications).id;
    }

    _.each(notifications, function(notification) {
      self.emit('notification', notification);
    });
    return cb();
  });
};

API.prototype._initNotifications = function(opts) {
  var self = this;

  opts = opts || {};

  var interval = opts.notificationIntervalSeconds || 5;
  self.notificationsIntervalId = setInterval(function() {
    self._fetchLatestNotifications(interval, function(err) {
      if (err) {
        if (err instanceof Errors.NOT_FOUND || err instanceof Errors.NOT_AUTHORIZED) {
          self._disposeNotifications();
        }
      }
    });
  }, interval * 1000);
};

API.prototype._disposeNotifications = function() {
  var self = this;

  if (self.notificationsIntervalId) {
    clearInterval(self.notificationsIntervalId);
    self.notificationsIntervalId = null;
  }
};

/**
 * Reset notification polling with new interval
 * @param {Numeric} notificationIntervalSeconds - use 0 to pause notifications
 */
API.prototype.setNotificationsInterval = function(notificationIntervalSeconds) {
  var self = this;
  self._disposeNotifications();
  if (notificationIntervalSeconds > 0) {
    self._initNotifications({
      notificationIntervalSeconds: notificationIntervalSeconds
    });
  }
};

/**
 * Encrypt a message
 * @private
 * @static
 * @memberof Client.API
 * @param {String} message
 * @param {String} encryptingKey
 */
API._encryptMessage = function(message, encryptingKey) {
  if (!message) return null;
  return Utils.encryptMessage(message, encryptingKey);
};

API.prototype._processTxNotes = function(notes) {
  var self = this;

  if (!notes) return;

  var encryptingKey = self.copayer.sharedEncryptingKey;
  _.each([].concat(notes), function(note) {
    note.encryptedBody = note.body;
    note.body = Utils.decryptMessageNoThrow(note.body, encryptingKey);
    note.encryptedEditedByName = note.editedByName;
    note.editedByName = Utils.decryptMessageNoThrow(note.editedByName, encryptingKey);
  });
};

/**
 * Decrypt text fields in transaction proposals
 * @private
 * @static
 * @memberof Client.API
 * @param {Array} txps
 * @param {String} encryptingKey
 */
API.prototype._processTxps = function(txps) {
  var self = this;
  if (!txps) return;

  var encryptingKey = self.copayer.sharedEncryptingKey;
  _.each([].concat(txps), function(txp) {
    txp.encryptedMessage = txp.message;
    txp.message = Utils.decryptMessageNoThrow(txp.message, encryptingKey) || null;
    txp.creatorName = Utils.decryptMessageNoThrow(txp.creatorName, encryptingKey);

    _.each(txp.actions, function(action) {
      action.copayerName = Utils.decryptMessageNoThrow(action.copayerName, encryptingKey);
      action.comment = Utils.decryptMessageNoThrow(action.comment, encryptingKey);
    });

    if (txp.app == 'data') {
      if (txp.params.hasEncrypted) {
        var data = Utils.decryptMessageNoThrow(txp.params.data, self.device.personalEncryptingKey) || null;
        if (data) txp.params.data = JSON.parse(data)
      }
    }
    self._processTxNotes(txp.note);
  });
};

/**
 * Parse errors
 * @private
 * @static
 * @memberof Client.API
 * @param {Object} body
 */
API._parseError = function(body) {
  if (!body) return;

  if (_.isString(body)) {
    try {
      body = JSON.parse(body);
    } catch (e) {
      body = {
        error: body
      };
    }
  }
  var ret;
  if (body.code) {
    if (Errors[body.code]) {
      ret = new Errors[body.code];
      if (body.message) ret.message = body.message;
    } else {
      ret = new Error(body.code + ': ' + body.message);
    }
  } else {
    ret = new Error(body.error || JSON.stringify(body));
  }
  log.error(ret);
  return ret;
};

/**
 * Sign an HTTP request
 * @private
 * @static
 * @memberof Client.API
 * @param {String} method - The HTTP method
 * @param {String} url - The URL for the request
 * @param {Object} args - The arguments in case this is a POST/PUT request
 * @param {String} privKey - Private key to sign the request
 */
API._signRequest = function(method, url, args, privKey) {
  var message = [method.toLowerCase(), url, JSON.stringify(args)].join('|');
  return Utils.signMessage(message, privKey);
};

var _deviceValidated;

/**
 * Seed from random
 *
 * @param {Object} opts
 * @param {String} opts.passphrase
 * @param {Boolean} opts.skipDeviceValidation
 */
API.prototype.validateKeyDerivation = function(opts, cb) {
  var self = this;

  opts = opts || {};

  var c = self.copayer;
  var d = self.device;

  function testMessageSigning(xpriv, xpub) {
    var nonHardenedPath = 'm/0/0';
    var message = 'Lorem ipsum dolor sit amet, ne amet urbanitas percipitur vim, libris disputando his ne, et facer suavitate qui. Ei quidam laoreet sea. Cu pro dico aliquip gubergren, in mundi postea usu. Ad labitur posidonium interesset duo, est et doctus molestie adipiscing.';
    var priv = xpriv.deriveChild(nonHardenedPath).privateKey;
    var signature = Utils.signMessage(message, priv);
    var pub = xpub.deriveChild(nonHardenedPath).publicKey;
    return Utils.verifyMessage(message, signature, pub);
  };

  function testHardcodedKeys() {
    var words = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    var xpriv = Mnemonic(words).toHDPrivateKey();

    if (xpriv.toString() != 'xprv9s21ZrQH143K3GJpoapnV8SFfukcVBSfeCficPSGfubmSFDxo1kuHnLisriDvSnRRuL2Qrg5ggqHKNVpxR86QEC8w35uxmGoggxtQTPvfUu') return false;

    xpriv = xpriv.deriveChild("m/44'/0'/0'");
    if (xpriv.toString() != 'xprv9xpXFhFpqdQK3TmytPBqXtGSwS3DLjojFhTGht8gwAAii8py5X6pxeBnQ6ehJiyJ6nDjWGJfZ95WxByFXVkDxHXrqu53WCRGypk2ttuqncb') return false;

    var xpub = Bitcore.HDPublicKey.fromString('xpub6BosfCnifzxcFwrSzQiqu2DBVTshkCXacvNsWGYJVVhhawA7d4R5WSWGFNbi8Aw6ZRc1brxMyWMzG3DSSSSoekkudhUd9yLb6qx39T9nMdj');
    return testMessageSigning(xpriv, xpub);
  };

  function testLiveKeys() {
    var words;
    try {
      words = d.getMnemonic();
    } catch (ex) {}

    var xpriv;
    if (words && (!d.mnemonicHasPassphrase || opts.passphrase)) {
      var m = new Mnemonic(words);
      xpriv = m.toHDPrivateKey(opts.passphrase, d.network);
    }
    if (!xpriv) {
      xpriv = new Bitcore.HDPrivateKey(d.xPrivKey);
    }
    var xpub = new Bitcore.HDPublicKey(d.xPubKey);

    return testMessageSigning(xpriv, xpub);
  };

  var hardcodedOk = true;
  if (!_deviceValidated && !opts.skipDeviceValidation) {
    hardcodedOk = testHardcodedKeys();
    _deviceValidated = true;
  }

  var liveOk = (d.canSign() && !d.isPrivKeyEncrypted()) ? testLiveKeys() : true;

  self.keyDerivationOk = hardcodedOk && liveOk;

  return cb(null, self.keyDerivationOk);
};

/**
 * Seed from random
 *
 * @param {Object} opts
 * @param {String} opts.coin [Optional] - default 'obyte'
 * @param {String} opts.network [Optional] - default 'livenet'
 */
API.prototype.seedFromRandom = function(opts) {
  opts = opts || {};
  this.device = Device.create(opts.coin || 'obyte', opts.network || 'livenet');
  var account = this.device.getNewAccount();
  this.copayer = this.device.addCopayer(account);
};

/**
 * Seed from random with mnemonic
 *
 * @param {Object} opts
 * @param {String} opts.coin - default 'obyte'
 * @param {String} opts.network - default 'livenet'
 * @param {String} opts.passphrase
 * @param {Number} opts.language - default 'en'
 * @param {Number} opts.account - default 0
 */
API.prototype.seedFromRandomWithMnemonic = function(opts) {
  opts = opts || {};
  this.device = Device.createWithMnemonic(opts.coin || 'obyte', opts.network || 'livenet', opts.passphrase, opts.language || 'en');
  var account = opts.account || 0;
  this.copayer = this.device.addCopayer(account);
};

API.prototype.getMnemonic = function() {
  return this.device.getMnemonic();
};

API.prototype.mnemonicHasPassphrase = function() {
  return this.device.mnemonicHasPassphrase;
};

API.prototype.clearMnemonic = function() {
  return this.device.clearMnemonic();
};

/**
 * Seed from extended private key
 *
 * @param {String} xPrivKey
 * @param {String} opts.coin - default 'obyte'
 * @param {Number} opts.account - default 0
 * @param {String} opts.derivationStrategy - default 'BIP44'
 */
API.prototype.seedFromExtendedPrivateKey = function(xPrivKey, opts) {
  opts = opts || {};
  this.device = Device.fromExtendedPrivateKey(opts.coin || 'obyte', xPrivKey, opts.derivationStrategy || Constants.DERIVATION_STRATEGIES.BIP44);
  var account = opts.account || 0;
  this.copayer = this.device.addCopayer(account);
  // TODO: scan all possible accounts
};

/**
 * Seed from Mnemonics (language autodetected)
 * Can throw an error if mnemonic is invalid
 *
 * @param {String} BIP39 words
 * @param {Object} opts
 * @param {String} opts.coin - default 'obyte'
 * @param {String} opts.network - default 'livenet'
 * @param {String} opts.passphrase
 * @param {Number} opts.account - default 0
 * @param {String} opts.derivationStrategy - default 'BIP44'
 */
API.prototype.seedFromMnemonic = function(words, opts) {
  $.checkArgument(_.isUndefined(opts) || _.isObject(opts), 'DEPRECATED: second argument should be an options object.');

  opts = opts || {};
  this.device = Device.fromMnemonic(opts.coin || 'obyte', opts.network || 'livenet', words, opts.passphrase, opts.derivationStrategy || Constants.DERIVATION_STRATEGIES.BIP44);
  var account = opts.account || 0;
  this.copayer = this.device.addCopayer(account);
  // TODO: scan all possible accounts
};

/**
 * Export wallet
 *
 * @param {Object} opts
 * @param {Boolean} opts.password
 * @param {Boolean} opts.noSign
 */
API.prototype.export = function(opts) {
  $.checkState(this.device);

  opts = opts || {};
  var output;
  var d = Device.fromObj(this.device);

  if (opts.noSign) {
    d.setNoSign();
  } else if (opts.password) {
    d.decryptPrivateKey(opts.password);
  }

  output = JSON.stringify(d.toObj());
  return output;
};

/**
 * Import wallet
 *
 * @param {Object} str - The serialized JSON created with #export
 */
API.prototype.import = function(str) {
  try {
    this.device = Device.fromObj(JSON.parse(str));
    if (!_.isEmpty(this.device.copayers))
      this.copayer = this.device.copayers[0];
  } catch (ex) {
    throw new Errors.INVALID_BACKUP;
  }
};

API.prototype._import = function(opts, cb) {
  $.checkState(this.device);
  opts = opts || {};

  var self = this;

  self.getCopayers(self.device.deviceId, function(err, copayers) {
    if (err) return cb(err);
    if (_.isEmpty(copayers)) {
      // TODO: Scan accounts and addresses
      var account = self.device.getNewAccount();
      self.copayer = self.device.addCopayer(account);
      self.createWallet(opts.walletName || 'my wallet', opts.copayerName || 'my copayer', 1, 1, {}, cb);
    } else {
      async.forEachSeries(copayers, function(copayer, done) {
        // Add account
        self.copayer = self.device.addCopayer(copayer.account);
        // First option, grab wallet info from OWS.
        self.openWallet(function(err, ret) {
          // it worked?
          if (!err) return done(null, ret);
  
          // Is the error other than "copayer was not found"? || or no priv key.
          if (err instanceof Errors.NOT_AUTHORIZED || self.isPrivKeyExternal())
            return done(err);
  
          //Second option, lets try to add an access
          log.info('Copayer not found, trying to add access');
          self.addAccess({}, function(err) {
            if (err) {
              return done(new Errors.WALLET_DOES_NOT_EXIST);
            }
            self.openWallet(done);
          });
        });
      }, function (err) {
        if (err) return cb(err);
        self.copayer = self.device.copayers[0];
        cb(null, copayers);
      });
    }
  });
};

/**
 * Import from Mnemonics (language auto detected)
 * Can throw an error if mnemonic is invalid
 *
 * @param {String} BIP39 words
 * @param {Object} opts
 * @param {String} opts.coin - default 'obyte'
 * @param {String} opts.network - default 'livenet'
 * @param {String} opts.passphrase
 * @param {String} opts.derivationStrategy - default 'BIP44'
 */
API.prototype.importFromMnemonic = function(words, opts, cb) {
  log.debug('Importing from Mnemonic');

  var self = this;
  opts = opts || {};

  try {
    self.device = Device.fromMnemonic(opts.coin || 'obyte', opts.network || 'livenet', words, opts.passphrase, opts.derivationStrategy || Constants.DERIVATION_STRATEGIES.BIP44);
  } catch (e) {
    log.info('Mnemonic error:', e);
    return cb(new Errors.INVALID_BACKUP);
  }

  self._import(opts, function(err) {
    if (!err) return cb(null);
    if (err instanceof Errors.INVALID_BACKUP) return cb(err);
    if (err instanceof Errors.NOT_AUTHORIZED || err instanceof Errors.WALLET_DOES_NOT_EXIST) {
      return cb(err);
    }
    return cb(err);
  });
};

/**
 * Import from extended private key
 *
 * @param {String} xPrivKey
 * @param {String} opts.coin - default 'obyte'
 * @param {String} opts.derivationStrategy - default 'BIP44'
 * @param {Callback} cb - The callback that handles the response. It returns a flag indicating that the wallet is imported.
 */
API.prototype.importFromExtendedPrivateKey = function(xPrivKey, opts, cb) {
  log.debug('Importing from Extended Private Key');

  if (!cb) {
    cb = opts;
    opts = {};
    log.warn('DEPRECATED WARN: importFromExtendedPrivateKey should receive 3 parameters.');
  }

  try {
    this.device = Device.fromExtendedPrivateKey(opts.coin || 'obyte', xPrivKey, opts.derivationStrategy || Constants.DERIVATION_STRATEGIES.BIP44);
  } catch (e) {
    log.info('xPriv error:', e);
    return cb(new Errors.INVALID_BACKUP);
  };

  this._import(opts, cb);
};

/**
 * Open a wallet and try to complete the public key ring.
 *
 * @param {Callback} cb - The callback that handles the response. It returns a flag indicating that the wallet is complete.
 * @fires API#walletCompleted
 */
API.prototype.openWallet = function(cb) {
  $.checkState(this.copayer);
  var self = this;
  if (self.copayer.isComplete() && self.copayer.hasWalletInfo())
    return cb(null, true);

  self._doGetRequest('/v1/wallets/?includeExtendedInfo=1', function(err, ret) {
    if (err) return cb(err);
    var wallet = ret.wallet;

    self._processStatus(ret);

    if (!self.copayer.hasWalletInfo()) {
      var me = _.find(wallet.copayers, {
        id: self.copayer.copayerId
      });
      self.copayer.addWalletInfo(self.device.deviceId, wallet.id, wallet.name, wallet.m, wallet.n, self.device.requestPubKey, me.name);
    }

    if (wallet.status != 'complete')
      return cb();

    if (self.copayer.walletPrivKey) {
      if (!Verifier.checkCopayers(self.copayer, wallet.copayers)) {
        return cb(new Errors.SERVER_COMPROMISED);
      }
    } else {
      // this should only happen in AIR-GAPPED flows
      log.warn('Could not verify copayers key (missing wallet Private Key)');
    }

    self.copayer.addPublicKeyRing(API._extractPublicKeyRing(wallet.copayers));

    self.emit('walletCompleted', wallet);

    return cb(null, ret);
  });
};

API.prototype._getHeaders = function(method, url, args) {
  var headers = {
    'x-client-version': 'owc-' + Package.version,
  };
  if (this.supportStaffWalletId) {
    headers['x-wallet-id'] = this.supportStaffWalletId;
  }

  return headers;
};

/**
 * Do an HTTP request
 * @private
 *
 * @param {Object} method
 * @param {String} url
 * @param {Object} args
 * @param {Callback} cb
 */
API.prototype._doRequest = function(method, url, args, useSession, cb) {
  var self = this;

  var headers = self._getHeaders(method, url, args);

  if (self.copayer) {
    headers['x-identity'] = self.copayer.copayerId;

    if (useSession && self.session) {
      headers['x-session'] = self.session;
    } else {
      var reqSignature;
      var key = args._requestPrivKey || self.device.requestPrivKey;
      if (key) {
        delete args['_requestPrivKey'];
        reqSignature = API._signRequest(method, url, args, key);
      }
      headers['x-signature'] = reqSignature;
    }
  }

  var r = self.request[method](self.baseUrl + url);

  r.accept('json');

  _.each(headers, function(v, k) {
    if (v) r.set(k, v);
  });

  if (args) {
    if (method == 'post' || method == 'put') {
      r.send(args);

    } else {
      r.query(args);
    }
  }

  r.timeout(self.timeout);

  r.end(function(err, res) {
    if (!res) {
      return cb(new Errors.CONNECTION_ERROR);
    }

    if (res.body)

      log.debug(util.inspect(res.body, {
        depth: 10
      }));

    if (res.status !== 200) {
      if (res.status === 404)
        return cb(new Errors.NOT_FOUND);

      if (!res.status)
        return cb(new Errors.CONNECTION_ERROR);

      log.error('HTTP Error:' + res.status);

      if (!res.body)
        return cb(new Error(res.status));

      return cb(API._parseError(res.body));
    }

    if (res.body === '{"error":"read ECONNRESET"}')
      return cb(new Errors.ECONNRESET_ERROR(JSON.parse(res.body)));

    return cb(null, res.body, res.header);
  });
};

API.prototype._login = function(cb) {
  this._doPostRequest('/v1/login', {}, cb);
};

API.prototype._logout = function(cb) {
  this._doPostRequest('/v1/logout', {}, cb);
};

/**
 * Do an HTTP request
 * @private
 *
 * @param {Object} method
 * @param {String} url
 * @param {Object} args
 * @param {Callback} cb
 */
API.prototype._doRequestWithLogin = function(method, url, args, cb) {
  var self = this;

  function doLogin(cb) {
    self._login(function(err, s) {
      if (err) return cb(err);
      if (!s) return cb(new Errors.NOT_AUTHORIZED);
      self.session = s;
      cb();
    });
  };

  async.waterfall([

    function(next) {
      if (self.session) return next();
      doLogin(next);
    },
    function(next) {
      self._doRequest(method, url, args, true, function(err, body, header) {
        if (err && err instanceof Errors.NOT_AUTHORIZED) {
          doLogin(function(err) {
            if (err) return next(err);
            return self._doRequest(method, url, args, true, next);
          });
        }
        next(null, body, header);
      });
    },
  ], cb);
};

/**
 * Do a POST request
 * @private
 *
 * @param {String} url
 * @param {Object} args
 * @param {Callback} cb
 */
API.prototype._doPostRequest = function(url, args, cb) {
  return this._doRequest('post', url, args, false, cb);
};

API.prototype._doPutRequest = function(url, args, cb) {
  return this._doRequest('put', url, args, false, cb);
};

/**
 * Do a GET request
 * @private
 *
 * @param {String} url
 * @param {Callback} cb
 */
API.prototype._doGetRequest = function(url, cb) {
  url += url.indexOf('?') > 0 ? '&' : '?';
  url += 'r=' + _.random(10000, 99999);
  return this._doRequest('get', url, {}, false, cb);
};

API.prototype._doGetRequestWithLogin = function(url, cb) {
  url += url.indexOf('?') > 0 ? '&' : '?';
  url += 'r=' + _.random(10000, 99999);
  return this._doRequestWithLogin('get', url, {}, cb);
};

/**
 * Do a DELETE request
 * @private
 *
 * @param {String} url
 * @param {Callback} cb
 */
API.prototype._doDeleteRequest = function(url, cb) {
  return this._doRequest('delete', url, {}, false, cb);
};

API._buildSecret = function(walletId, walletPrivKey, coin, network) {
  if (_.isString(walletPrivKey)) {
    walletPrivKey = Bitcore.PrivateKey.fromString(walletPrivKey);
  }
  var widHex = new Buffer(walletId.replace(/-/g, ''), 'hex');
  var widBase58 = new Bitcore.encoding.Base58(widHex).toString();
  return _.padEnd(widBase58, 22, '0') + walletPrivKey.toWIF() + (network == 'testnet' ? 'T' : 'L') + coin;
};

API.parseSecret = function(secret) {
  $.checkArgument(secret);

  function split(str, indexes) {
    var parts = [];
    indexes.push(str.length);
    var i = 0;
    while (i < indexes.length) {
      parts.push(str.substring(i == 0 ? 0 : indexes[i - 1], indexes[i]));
      i++;
    };
    return parts;
  };

  try {
    var secretSplit = split(secret, [22, 74, 75]);
    var widBase58 = secretSplit[0].replace(/0/g, '');
    var widHex = Bitcore.encoding.Base58.decode(widBase58).toString('hex');
    var walletId = split(widHex, [8, 12, 16, 20]).join('-');

    var walletPrivKey = Bitcore.PrivateKey.fromString(secretSplit[1]);
    var networkChar = secretSplit[2];
    var coin = secretSplit[3] || 'obyte';

    return {
      walletId: walletId,
      walletPrivKey: walletPrivKey,
      coin: coin,
      network: networkChar == 'T' ? 'testnet' : 'livenet',
    };
  } catch (ex) {
    throw new Error('Invalid secret');
  }
};

API.signTxp = function(txp, xpriv, walletId) {
  var objUnit = txp.unit;
  var assocSigningInfo = txp.signingInfo;
  var signatures = {};
  var text_to_sign = ObjectHash.getUnitHashToSign(objUnit);
  for (var author of objUnit.authors) {
    var address = author.address;
    if (walletId == assocSigningInfo[address].walletId) {
      var signingPaths = assocSigningInfo[address].signingPaths;
      var x = xpriv.derive(assocSigningInfo[address].path);
      var publicKey = x.publicKey.toBuffer().toString('base64');
      var privateKey = x.privateKey;
      var privKeyBuf = privateKey.bn.toBuffer({ size: 32 });
      if (publicKey in signingPaths) {
        author.authentifiers[signingPaths[publicKey]] = EcdsaSig.sign(text_to_sign, privKeyBuf);
      }
      signatures[address] = author.authentifiers; 
    }
  }
  return signatures;
};

API.prototype._signTxp = function(txp, password) {
  var derived = this.device.getDerivedXPrivKey(this.copayer.account, password);
  return API.signTxp(txp, derived, this.copayer.walletId);
};

API.prototype._getCurrentSignatures = function(txp) {
  var acceptedActions = _.filter(txp.actions, {
    type: 'accept'
  });

  return _.map(acceptedActions, function(x) {
    return {
      signatures: x.signatures,
      xpub: x.xpub,
    };
  });
};

/**
 * Join
 * @private
 *
 * @param {String} walletId
 * @param {String} walletPrivKey
 * @param {String} xPubKey
 * @param {String} requestPubKey
 * @param {String} copayerName
 * @param {Object} opts
 * @param {String} opts.customData
 * @param {String} opts.coin
 * @param {Callback} cb
 */
API.prototype._doJoinWallet = function(walletId, walletPrivKey, xPubKey, deviceId, account, requestPubKey, copayerName, opts, cb) {
  $.shouldBeFunction(cb);
  var self = this;

  opts = opts || {};

  // Adds encrypted walletPrivateKey to CustomData
  opts.customData = opts.customData || {};
  opts.customData.walletPrivKey = walletPrivKey.toString();
  var encCustomData = Utils.encryptMessage(JSON.stringify(opts.customData), self.device.personalEncryptingKey);
  var encCopayerName = Utils.encryptMessage(copayerName, self.copayer.sharedEncryptingKey);

  var args = {
    deviceId: deviceId,
    walletId: walletId,
    coin: opts.coin,
    name: encCopayerName,
    xPubKey: xPubKey,
    account: account,
    requestPubKey: requestPubKey,
    customData: encCustomData,
  };
  if (opts.dryRun) args.dryRun = true;

  if (_.isBoolean(opts.supportBIP44))
    args.supportBIP44 = opts.supportBIP44;

  var hash = Utils.getCopayerHash(args.name, args.xPubKey, args.requestPubKey);
  args.copayerSignature = Utils.signMessage(hash, walletPrivKey);

  var url = '/v1/wallets/' + walletId + '/copayers';
  self._doPostRequest(url, args, function(err, body) {
    if (err) return cb(err);
    self._processWallet(body.wallet);
    return cb(null, body.wallet);
  });
};

/**
 * Return if wallet is complete
 */
API.prototype.isComplete = function() {
  return this.copayer && this.copayer.isComplete();
};

/**
 * Is private key currently encrypted?
 *
 * @return {Boolean}
 */
API.prototype.isPrivKeyEncrypted = function() {
  return this.device && this.device.isPrivKeyEncrypted();
};

/**
 * Is private key external?
 *
 * @return {Boolean}
 */
API.prototype.isPrivKeyExternal = function() {
  return this.device && this.device.hasExternalSource();
};

/**
 * Get external wallet source name
 *
 * @return {String}
 */
API.prototype.getPrivKeyExternalSourceName = function() {
  return this.device ? this.device.getExternalSourceName() : null;
};

/**
 * Returns unencrypted extended private key and mnemonics
 *
 * @param password
 */
API.prototype.getKeys = function(password) {
  return this.device.getKeys(password);
};

/**
 * Checks is password is valid
 * Returns null (keys not encrypted), true or false.
 *
 * @param password
 */
API.prototype.checkPassword = function(password) {
  if (!this.isPrivKeyEncrypted()) return;

  try {
    var keys = this.getKeys(password);
    return !!keys.xPrivKey;
  } catch (e) {
    return false;
  };
};

/**
 * Can this device sign a transaction?
 * (Only returns fail on a 'proxy' setup for airgapped operation)
 *
 * @return {undefined}
 */
API.prototype.canSign = function() {
  return this.device && this.device.canSign();
};

API._extractPublicKeyRing = function(copayers) {
  return _.map(copayers, function(copayer) {
    var pkr = _.pick(copayer, ['xPubKey', 'requestPubKey', 'deviceId', 'account']);
    pkr.copayerName = copayer.name;
    return pkr;
  });
};

/**
 * sets up encryption for the extended private key
 *
 * @param {String} password Password used to encrypt
 * @param {Object} opts optional: SJCL options to encrypt (.iter, .salt, etc).
 * @return {undefined}
 */
API.prototype.encryptPrivateKey = function(password, opts) {
  this.device.encryptPrivateKey(password, opts || API.privateKeyEncryptionOpts);
};

/**
 * disables encryption for private key.
 *
 * @param {String} password Password used to encrypt
 */
API.prototype.decryptPrivateKey = function(password) {
  return this.device.decryptPrivateKey(password);
};

/**
 * Get all copayers in deviceId
 */
API.prototype.getCopayers = function(deviceId, cb) {
  var self = this;

  $.checkArgument(deviceId);

  self._doGetRequest('/v1/copayers/?deviceId=' + deviceId, function(err, copayers) {
    if (err) return cb(err);
    return cb(err, copayers);
  });
}

/**
 * Get service version
 *
 * @param {Callback} cb
 */
API.prototype.getVersion = function(cb) {
  this._doGetRequest('/v1/version/', cb);
};

API.prototype._checkKeyDerivation = function() {
  var isInvalid = (this.keyDerivationOk === false);
  if (isInvalid) {
    log.error('Key derivation for this device is not working as expected');
  }
  return !isInvalid;
};

/**
 * Create a wallet
 * 
 * @param {String} walletName [Required] - The wallet name.
 * @param {String} copayerName [Required] - The copayer name.
 * @param {Number} m [Required] - Required copayers.
 * @param {Number} n [Required] - Total copayers.
 * @param {object} opts [Optional] - Advanced options.
 * @param {String} opts.coin[='obyte'] - The coin for this wallet.
 * @param {String} opts.network[='livenet']
 * @param {String} opts.singleAddress[=true] - The wallet will only ever have one address.
 * @param {String} opts.walletPrivKey - Set a walletPrivKey (instead of random)
 * @param {String} opts.id - Set a id for wallet (instead of server given)
 * @return {Callback} cb - When n>1, return the multi-sig wallet secret.
 */
API.prototype.createWallet = function(walletName, copayerName, m, n, opts, cb) {
  var self = this;

  if (!self._checkKeyDerivation()) return cb(new Error('Cannot create new wallet'));

  if (opts) $.shouldBeObject(opts);
  opts = opts || {};

  var coin = opts.coin || 'obyte';
  if (!_.includes(['obyte'], coin)) return cb(new Error('Invalid coin'));

  var network = opts.network || 'livenet';
  if (!_.includes(['testnet', 'livenet'], network)) return cb(new Error('Invalid network'));

  var singleAddress = _.isUndefined(opts.singleAddress) ? true : opts.singleAddress;

  if (!self.device) {
    log.info('Generating new keys');
    self.seedFromRandomWithMnemonic({
      coin: coin,
      network: network
    });
  } else {
    log.info('Using existing keys');
  }

  if (coin != self.device.coin) {
    return cb(new Error('Existing keys were created for a different coin'));
  }

  if (network != self.device.network) {
    return cb(new Error('Existing keys were created for a different network'));
  }
  
  if (!self.copayer) {
    return cb(new Error('Existing keys have no copayer'));
  }

  var walletPrivKey = opts.walletPrivKey || new Bitcore.PrivateKey();

  var d = self.device;
  var c = self.copayer;
  c.addWalletPrivateKey(walletPrivKey.toString());
  var encWalletName = Utils.encryptMessage(walletName, c.sharedEncryptingKey);

  var args = {
    name: encWalletName,
    m: m,
    n: n,
    pubKey: (new Bitcore.PrivateKey(walletPrivKey)).toPublicKey().toString(),
    coin: coin,
    network: network,
    singleAddress: !!singleAddress,
    id: opts.id,
  };

  self._doPostRequest('/v1/wallets/', args, function(err, res) {
    if (err) return cb(err);

    var walletId = res.walletId;
    c.addWalletInfo(d.deviceId, walletId, walletName, m, n, d.requestPubKey, copayerName);
    var secret = API._buildSecret(c.walletId, c.walletPrivKey, d.coin, d.network);

    self._doJoinWallet(walletId, walletPrivKey, c.xPubKey, d.deviceId, c.account, d.requestPubKey, copayerName, {
        coin: coin
      },
      function(err, wallet) {
        if (err) return cb(err);
        return cb(null, n > 1 ? secret : null);
      });
  });
};

/**
 * Join an existent wallet
 * 
 * @param {String} secret [Required] - The multi-sig wallet secret.
 * @param {String} copayerName [Required] - The copayer name.
 * @param {Object} opts [Optional]
 * @param {String} opts.coin[='obyte'] - The expected coin for this wallet.
 * @param {Boolean} opts.dryRun[=false] - Simulate wallet join
 * @return {Callback} cb - Returns the wallet
 */
API.prototype.joinWallet = function(secret, copayerName, opts, cb) {
  var self = this;

  if (!cb) {
    cb = opts;
    opts = {};
    log.warn('DEPRECATED WARN: joinWallet should receive 4 parameters.');
  }

  if (!self._checkKeyDerivation()) return cb(new Error('Cannot join wallet'));

  opts = opts || {};

  var coin = opts.coin || 'obyte';
  if (!_.includes(['obyte'], coin)) return cb(new Error('Invalid coin'));

  try {
    var secretData = API.parseSecret(secret);
  } catch (ex) {
    return cb(ex);
  }

  if (!self.device) {
    self.seedFromRandom({
      coin: coin,
      network: secretData.network
    });
  }

  self.copayer.addWalletPrivateKey(secretData.walletPrivKey.toString());
  self._doJoinWallet(secretData.walletId, secretData.walletPrivKey, self.copayer.xPubKey, self.device.deviceId, self.copayer.account, self.device.requestPubKey, copayerName, {
    coin: coin,
    dryRun: !!opts.dryRun,
  }, function(err, wallet) {
    if (err) return cb(err);
    if (!opts.dryRun) {
      self.copayer.addWalletInfo(self.device.deviceId, wallet.id, wallet.name, wallet.m, wallet.n, self.device.requestPubKey, copayerName);
    }
    return cb(null, wallet);
  });
};

/**
 * Recreates a wallet, given copayer (with wallet id)
 *
 * @return {Callback} cb - Returns the wallet
 */
API.prototype.recreateWallet = function(cb) {
  $.checkState(this.device);
  $.checkState(this.copayer);
  $.checkState(this.copayer.isComplete());
  $.checkState(this.copayer.walletPrivKey);
  //$.checkState(this.copayer.hasWalletInfo());
  var self = this;

  // First: Try to get the wallet with current copayer
  this.getStatus({
    includeExtendedInfo: true
  }, function(err) {
    // No error? -> Wallet is ready.
    if (!err) {
      log.info('Wallet is already created');
      return cb();
    };

    var d = self.device;
    var c = self.copayer;
    var walletPrivKey = Bitcore.PrivateKey.fromString(c.walletPrivKey);
    var walletId = c.walletId;
    var supportBIP44 = d.derivationStrategy != Constants.DERIVATION_STRATEGIES.BIP45;
    var encWalletName = Utils.encryptMessage(c.walletName || 'recovered wallet', c.sharedEncryptingKey);

    var args = {
      name: encWalletName,
      m: c.m,
      n: c.n,
      pubKey: walletPrivKey.toPublicKey().toString(),
      coin: d.coin,
      network: d.network,
      id: walletId,
      supportBIP44: supportBIP44,
    };

    self._doPostRequest('/v1/wallets/', args, function(err, body) {
      if (err) {
        if (!(err instanceof Errors.WALLET_ALREADY_EXISTS))
          return cb(err);

        return self.addAccess({}, function(err) {
          if (err) return cb(err);
          self.openWallet(function(err) {
            return cb(err);
          });
        });
      }

      if (!walletId) {
        walletId = body.walletId;
      }

      var i = 1;
      async.each(self.copayer.publicKeyRing, function(item, next) {
        var name = item.copayerName || ('copayer ' + i++);
        self._doJoinWallet(walletId, walletPrivKey, item.xPubKey, item.deviceId, item.account, item.requestPubKey, name, {
          coin: d.coin,
          supportBIP44: supportBIP44,
        }, function(err) {
          //Ignore error is copayer already in wallet
          if (err && err instanceof Errors.COPAYER_IN_WALLET) return next();
          return next(err);
        });
      }, cb);
    });
  });
};

/**
 * Update wallet name and copayer name
 *
 * @param {Object} opts
 * @param {String} opts.walletName [Optional] - The wallet name
 * @param {String} opts.copayerName [Optional] - The copayer name
 * @return {Callback} cb - Return error or wallet object
 */
API.prototype.updateWallet = function(opts, cb) {
  $.checkState(this.device);
  $.checkState(this.copayer);
  $.checkArgument(opts);

  var self = this;
  if (opts.walletName) {
    opts.walletName = Utils.encryptMessage(opts.walletName, self.copayer.sharedEncryptingKey);
  }
  if (opts.copayerName) {
    opts.copayerName = Utils.encryptMessage(opts.copayerName, self.copayer.sharedEncryptingKey);
    var hash = Utils.getCopayerHash(opts.copayerName, self.copayer.xPubKey, self.device.requestPubKey);
    opts.copayerSignature = Utils.signMessage(hash, self.copayer.walletPrivKey);
  }

  self._doPutRequest('/v1/wallets/', opts, function (err, wallet) {
    if (err) return cb(err);
    self._processWallet(wallet);
    var me = _.find(wallet.copayers, {
      id: self.copayer.copayerId
    });
    self.copayer.walletName = wallet.name;
    self.copayer.copayerName = me.name;
    return cb();
  });
};

API.prototype._processWallet = function(wallet) {
  var self = this;

  var encryptingKey = self.copayer.sharedEncryptingKey;

  var name = Utils.decryptMessageNoThrow(wallet.name, encryptingKey);
  if (name != wallet.name) {
    wallet.encryptedName = wallet.name;
  }
  wallet.name = name;
  _.each(wallet.copayers, function(copayer) {
    var name = Utils.decryptMessageNoThrow(copayer.name, encryptingKey);
    if (name != copayer.name) {
      copayer.encryptedName = copayer.name;
    }
    copayer.name = name;
    _.each(copayer.requestPubKeys, function(access) {
      if (!access.name) return;

      var name = Utils.decryptMessageNoThrow(access.name, encryptingKey);
      if (name != access.name) {
        access.encryptedName = access.name;
      }
      access.name = name;
    });
  });
};

API.prototype._processStatus = function(status) {
  var self = this;

  function processCustomData(data) {
    var copayers = data.wallet.copayers;
    if (!copayers) return;

    var me = _.find(copayers, {
      'id': self.copayer.copayerId
    });
    if (!me || !me.customData) return;

    var customData;
    try {
      customData = JSON.parse(Utils.decryptMessage(me.customData, self.device.personalEncryptingKey));
    } catch (e) {
      log.warn('Could not decrypt customData:', me.customData);
    }
    if (!customData) return;

    // Add it to result
    data.customData = customData;

    // Update walletPrivateKey
    if (!self.copayer.walletPrivKey && customData.walletPrivKey)
      self.copayer.addWalletPrivateKey(customData.walletPrivKey);
  };

  processCustomData(status);
  self._processWallet(status.wallet);
  self._processTxps(status.pendingTxps);
}

/**
 * Get latest notifications
 *
 * @param {object} opts
 * @param {String} opts.lastNotificationId [Optional] - The ID of the last received notification
 * @param {String} opts.timeSpan [Optional] - A time window on which to look for notifications (in seconds)
 * @param {String} opts.includeOwn[=false] [Optional] - Do not ignore notifications generated by the current copayer
 * @return {Callback} cb - Returns error or an array of notifications
 */
API.prototype.getNotifications = function(opts, cb) {
  $.checkState(this.copayer);

  var self = this;
  opts = opts || {};

  var url = '/v1/notifications/';
  if (opts.lastNotificationId) {
    url += '?notificationId=' + opts.lastNotificationId;
  } else if (opts.timeSpan) {
    url += '?timeSpan=' + opts.timeSpan;
  }

  self._doGetRequestWithLogin(url, function(err, result) {
    if (err) return cb(err);

    var notifications = _.filter(result, function(notification) {
      return opts.includeOwn || (notification.creatorId != self.copayer.copayerId);
    });

    return cb(null, notifications);
  });
};

/**
 * Get status of the wallet
 *
 * @param {Boolean} opts.includeExtendedInfo [Optional] - query extended status
 * @return {Callback} cb - Returns error or an object with status information
 */
API.prototype.getStatus = function(opts, cb) {
  $.checkState(this.device);
  $.checkState(this.copayer);

  if (!cb) {
    cb = opts;
    opts = {};
    log.warn('DEPRECATED WARN: getStatus should receive 2 parameters.')
  }

  var self = this;
  opts = opts || {};
  opts.includeExtendedInfo = _.isUndefined(opts.includeExtendedInfo) ? false : opts.includeExtendedInfo;

  var qs = [];
  qs.push('includeExtendedInfo=' + (opts.includeExtendedInfo ? '1' : '0'));

  self._doGetRequest('/v1/wallets/?' + qs.join('&'), function(err, result) {
    if (err) return cb(err);
    if (result.wallet.status == 'pending') {
      var d = self.device;
      var c = self.copayer;
      result.wallet.secret = API._buildSecret(c.walletId, c.walletPrivKey, d.coin, d.network);
    }

    self._processStatus(result);

    return cb(err, result);
  });
};

/**
 * Get copayer preferences
 * 
 * @return {Callback} cb - Return error or object
 */
API.prototype.getPreferences = function(cb) {
  $.checkState(this.device);
  $.checkState(this.copayer);
  $.checkArgument(cb);

  var self = this;
  self._doGetRequest('/v1/preferences/', function(err, preferences) {
    if (err) return cb(err);
    return cb(null, preferences);
  });
};

/**
 * Save copayer preferences
 *
 * @param {Object} preferences
 * @return {Callback} cb - Return error or object
 */
API.prototype.savePreferences = function(preferences, cb) {
  $.checkState(this.device);
  $.checkState(this.copayer);
  $.checkArgument(cb);

  var self = this;
  self._doPutRequest('/v1/preferences/', preferences, cb);
};

/**
 * Gets list of utxos
 *
 * @param {Object} opts
 * @param {Array} opts.addresses [Optional] - List of addresses from where to fetch UTXOs.
 * @return {Callback} cb - Return error or the list of utxos
 */
API.prototype.getUtxos = function(opts, cb) {
  $.checkState(this.device);
  $.checkState(this.copayer && this.copayer.isComplete());
  opts = opts || {};
  var url = '/v1/utxos/';
  if (opts.addresses) {
    url += url.indexOf('?') > 0 ? '&' : '?';
    url += querystring.stringify({
      addresses: [].concat(opts.addresses).join(',')
    });
  }
  if (opts.asset) {
    url += url.indexOf('?') > 0 ? '&' : '?';
    url += querystring.stringify({
      asset: opts.asset
    });
  }
  this._doGetRequest(url, cb);
};

API.prototype._getCreateTxProposalArgs = function(opts) {
  var self = this;

  var args = _.cloneDeep(opts);
  args.message = API._encryptMessage(opts.message, self.copayer.sharedEncryptingKey) || null;

  if (opts.app == 'data') {
    if (opts.params.hasEncrypted) {
      var data = JSON.stringify(opts.params.data)
      args.params.data = API._encryptMessage(data, self.device.personalEncryptingKey) || null
    }
  }

  return args;
};

/**
 * Create a transaction proposal
 *
 * @param {Object} opts
 * @param {String} opts.txProposalId [Optional] - If provided it will be used as this TX proposal ID. Should be unique in the scope of the wallet.
 * @param {String} opts.app [Required] - Transaction proposal type. (defaults to 'payment', others include 'text', 'data', 'data feed', 'profile', 'poll', 'vote', etc.)
 * @param {Object} opts.params [Required] - Params for app.
 * @param {String} opts.message [Optional] - A message to attach to this transaction.
 * @param {Boolean} opts.dryRun [Optional] - Simulate the action but do not change server state.
 * @return {Callback} cb - Return error or the transaction proposal.
 *
 * app: payment
 * @param {String} opts.params.asset [Optional] - Hash of unit where the asset was defined. (defaults to null).
 * @param {Array} opts.params.outputs [Required] - List of outputs.
 * @param {String} opts.params.outputs[].address [Required] - Destination address.
 * @param {number} opts.params.outputs[].amount [Required] - Amount to transfer.
 * @param {Array} opts.params.inputs [Optional] - Inputs for this TX
 * @param {String} opts.params.change_address [Optional] - Use this address as the change address for the tx. The address should belong to the wallet. In the case of singleAddress wallets, the first main address will be used.
 * @param {Boolean} opts.params.send_all [Optional] - Send maximum amount of bytes. (defaults to false).
 * @param {Boolean} opts.params.spend_unconfirmed [Optional] - UTXOs of unconfirmed transactions as inputs. (defaults to 'own', others include 'all', 'none')
 *
 * app: data - One can store arbitrary structured data using 'data' message type.
 * @param {Object} opts.params [Required] - Structured data of key-value
 *
 * app: text - One can store arbitrary texts using 'text' message type.
 * @param {String} opts.params [Required] - Text to store.
 *
 * app: profile - Users can store their profiles on Obyte if they want.
 * @param {Object} opts.params [Required] - Profile data of key-value.
 *
 * app: poll - Anyone can set up a poll by sending a message with app='poll'.
 * @param {String} opts.params.questions [Required] - Question of the poll.
 * @param {Array} opts.params.choices [Required] - Allowed set of choices.
 *
 * app: vote - To cast votes, users send 'vote' messages.
 * @param {String} opts.params.unit [Required] - Hash of unit where the poll was defined.
 * @param {String} opts.params.choice [Required] - Indicate what the user want to vote for. The choice must be defined in the poll message.
 *
 * app: data_feed - Data fields can be used to design definitions that involve oracles.
 * @param {Object} opts.params [Required] - Data feed of key-value.
 *
 * app: attestation - Attestations confirm that the user who issued the attestation (the attestor) verified some data about the attested user (the subject).
 * @param {String} opts.params.address [Required] - Address of the attested user (the subject).
 * @param {Object} opts.params.profile [Required] - Verified data about the attested user.
 *
 * app: asset - Assets in OByte can be issued, transferred, and exchanged, and.they behave similarly to the native currency ‘bytes'.
 * @param {Number} opts.params.cap [Optional] - Is the total number of coins that can be issued (money supply). If omitted, the number is unlimited.
 * @param {Boolean} opts.params.is_private [Required] - Indicates whether the asset is private (such as blackbytes) or publicly traceable (similar to bytes).
 * @param {Boolean} opts.params.is_transferrable [Required] - Indicates whether the asset can be freely transferred among arbitrary parties or all transfers should involve the definer address as either sender or recipient. The latter can be useful e.g. for loyalty points that cannot be resold.
 * @param {Boolean} opts.params.auto_destroy [Required] - Indicates whether the asset is destroyed when it is sent to the definer address.
 * @param {Boolean} opts.params.fixed_denominations [Required] - Indicates whether the asset exists as coins (banknotes) of a limited set of denominations, similar to blackbytes. If it is true, the definition must also include property denominations, which is an array of all denominations and the number of coins of that denomination.
 * @param {Array} opts.params.denominations [Optional] - Optional. Array of all denominations and the number of coins of that denomination.
 * @param {Boolean} opts.params.issued_by_definer_only [Required] - Indicates whether the asset can be issued only by the definer address. If false, anyone can issue the asset, in this case cap must be unlimited.
 * @param {Boolean} opts.params.cosigned_by_definer [Required] - Indicates whether each operation with the asset must be cosigned by the definer address. Useful for regulated assets where the issuer (bank) wants to perform various compliance checks (such as the funds are not arrested by a court order) prior to approving a transaction.
 * @param {Boolean} opts.params.spender_attested [Required] - Indicates whether the spender of the asset must be attested by one of approved attestors. Also useful for regulated assets e.g. to limit the access to the asset only to KYC'ed users. If true, the definition must also include the list of approved attestor addresses.
 * @param {Array} opts.params.attestors [Optional] - List of approved attestor addresses
 * @param {Array} opts.params.issue_condition [Optional] - Specify the restrictions when the asset can be issued. It evaluate to a boolean and are coded in the same smart contract language as address definitions.
 * @param {Array} opts.params.transfer_condition [Optional] - Specify the restrictions when the asset can be transferred. It evaluate to a boolean and are coded in the same smart contract language as address definitions.
 *
 * app: asset_attestors - The list of an asset attestors can be amended by the definer by sending an ‘asset_attestors' message that replaces the list of attestors.
 * @param {String} opts.params.asset [Required] - Asset unit id.
 * @param {Array} opts.params.attestors [Required] - List of approved attestor addresses.
 *
 * app: address definition change - Users can update definitions of their addresses while keeping the old address.
 * @param {String} opts.params.definition_chash [Required] - Indicates the checksummed hash of the new address definition.
 * @param {String} opts.params.address [Optional] - When multi-authored, must indicate address.
 *
 * app: definition_template - The template looks like normal definition but may include references to variables in the syntax @param1, @param2. Definition templates enable code reuse. They may in turn reference other templates.
 * @param {Array} opts.params [Required] - Definition template.
 *
 * For test mode
 * @param {Boolean} opts.testRun [Optional] - Add transaction proposal for test mode.
 * @param {Object} opts.unit [Optional] - Unit data for test mode.
 * @param {Object} opts.signingInfo [Optional] - Signing information for test mode.
 *
 */
API.prototype.createTxProposal = function(opts, cb) {
  $.checkState(this.device);
  $.checkState(this.copayer && this.copayer.isComplete());
  $.checkState(this.copayer.sharedEncryptingKey);
  $.checkArgument(opts);
  $.checkArgument(opts.params)

  var self = this;

  var args = self._getCreateTxProposalArgs(opts);

  self._doPostRequest('/v1/txproposals/', args, function(err, txp) {
    if (err) return cb(err);

    self._processTxps(txp);
    if (!Verifier.checkProposalCreation(args, txp, self.copayer.sharedEncryptingKey)) {
      return cb(new Errors.SERVER_COMPROMISED);
    }

    return cb(null, txp);
  });
};

/**
 * Publish a transaction proposal
 *
 * @param {Object} opts
 * @param {Object} opts.txp [Required] - The transaction proposal object returned by the API#createTxProposal method
 * @return {Callback} cb - Return error or null
 */
API.prototype.publishTxProposal = function(opts, cb) {
  $.checkState(this.device);
  $.checkState(this.copayer && this.copayer.isComplete());
  $.checkArgument(opts)
    .checkArgument(opts.txp);

  var self = this;

  var objUnit = opts.txp.unit;
  var hash = ObjectHash.getUnitHashToSign(objUnit);
  var args = {
    proposalSignature: Utils.signMessage(hash, self.device.requestPrivKey)
  };

  var url = '/v1/txproposals/' + opts.txp.id + '/publish/';
  self._doPostRequest(url, args, function(err, txp) {
    if (err) return cb(err);
    self._processTxps(txp);
    return cb(null, txp);
  });
};

/**
 * Create a new address
 *
 * @param {Object} opts
 * @param {Boolean} opts.ignoreMaxGap [Optional] - Defaults to false.
 * @return {Callback} cb - Return error or the address
 */
API.prototype.createAddress = function(opts, cb) {
  $.checkState(this.device);
  $.checkState(this.copayer && this.copayer.isComplete());

  var self = this;

  if (!cb) {
    cb = opts;
    opts = {};
    log.warn('DEPRECATED WARN: createAddress should receive 2 parameters.')
  }

  if (!self._checkKeyDerivation()) return cb(new Error('Cannot create new address for this wallet'));

  opts = opts || {};

  self._doPostRequest('/v1/addresses/', opts, function(err, address) {
    if (err) return cb(err);

    if (!Verifier.checkAddress(self.copayer, address)) {
      return cb(new Errors.SERVER_COMPROMISED);
    }

    return cb(null, address);
  });
};

/**
 * Get your main addresses
 *
 * @param {Object} opts
 * @param {Boolean} opts.doNotVerify [Optional] - Check if the address is correct.
 * @param {Numeric} opts.limit [Optional] - Limit the resultset. Return all addresses by default.
 * @param {Boolean} opts.reverse [Optional] - Reverse the order of returned addresses. (defaults to false).
 * @return {Callback} cb - Return error or the array of addresses
 */
API.prototype.getMainAddresses = function(opts, cb) {
  $.checkState(this.device);
  $.checkState(this.copayer && this.copayer.isComplete());

  var self = this;

  opts = opts || {};

  var args = [];
  if (opts.limit) args.push('limit=' + opts.limit);
  if (opts.reverse) args.push('reverse=1');
  var qs = '';
  if (args.length > 0) {
    qs = '?' + args.join('&');
  }
  var url = '/v1/addresses/' + qs;

  self._doGetRequest(url, function(err, addresses) {
    if (err) return cb(err);

    if (!opts.doNotVerify) {
      var fake = _.some(addresses, function(address) {
        return !Verifier.checkAddress(self.copayer, address);
      });
      if (fake)
        return cb(new Errors.SERVER_COMPROMISED);
    }
    return cb(null, addresses);
  });
};

/**
 * Get wallet balance
 *
 * @param {String} opts.coin [Optional] - defaults to 'obyte'.
 * @param {Boolean} opts.asset [Optional] - Asset. 'all' for all assets, null and 'base' and 'bytes' for bytes. (defaults to 'all').
 * @return {Callback} cb - return error or balance.
 */
API.prototype.getBalance = function(opts, cb) {
  $.checkState(this.device);
  $.checkState(this.copayer && this.copayer.isComplete());

  if (!cb) {
    cb = opts;
    opts = {};
    log.warn('DEPRECATED WARN: getBalance should receive 2 parameters.')
  }

  var self = this;
  opts = opts || {};

  var args = [];
  if (opts.coin) {
    if (!_.includes(['obyte'], opts.coin)) return cb(new Error('Invalid coin'));
    args.push('coin=' + opts.coin);
  }
  if (opts.asset) {
    args.push('asset=' + opts.asset);
  }
  var qs = '';
  if (args.length > 0) {
    qs = '?' + args.join('&');
  }

  var url = '/v1/balance/' + qs;
  this._doGetRequest(url, cb);
};

/**
 * Get list of transactions proposals
 *
 * @param {Object} opts
 * @param {Number} opts.minTs [Optional] - The min time tx proposal created.
 * @param {Number} opts.maxTs [Optional] - The max time tx proposal created.
 * @param {Number} opts.limit [Optional] - The size of result set.
 * @param {String} opts.status [Optional] - Tx proposal status including 'temporary', 'pending', 'accepted', 'broadcasted', 'rejected'.
 * @return {Callback} cb - Return error or array of transactions proposals
 */
API.prototype.getTxProposals = function(opts, cb) {
  $.checkState(this.device);
  $.checkState(this.copayer && this.copayer.isComplete());

  var self = this;
  opts = opts || {};

  var args = [];
  if (opts.minTs) {
    args.push('minTs=' + opts.minTs);
  }
  if (opts.maxTs) {
    args.push('maxTs=' + opts.maxTs);
  }
  if (opts.limit) {
    args.push('limit=' + opts.limit);  
  }
  if (opts.status) {
    if (!_.includes(['temporary', 'pending', 'accepted', 'broadcasted', 'rejected'], opts.status)) return cb(new Error('Invalid status'));
    args.push('status=' + opts.status);  
  }
  if (opts.app) {
    args.push('app=' + opts.app);  
  }
  if (opts.isPending) {
    args.push('isPending=' + opts.isPending);  
  }
  var qs = '';
  if (args.length > 0) {
    qs = '?' + args.join('&');
  }

  var url = '/v1/txproposals/' + qs;
  self._doGetRequest(url, function(err, txps) {
    if (err) return cb(err);

    self._processTxps(txps);
    return cb(null, txps);
  });
}

/**
 * Get list of pending transactions proposals
 *
 * @return {Callback} cb - Return error or array of transactions proposals
 */
API.prototype.getPendingTxProposals = function(opts, cb) {
  $.checkState(this.device);
  $.checkState(this.copayer && this.copayer.isComplete());

  var self = this;
  var url = '/v1/txproposals/pending/';
  self._doGetRequest(url, function(err, txps) {
    if (err) return cb(err);

    self._processTxps(txps);
    return cb(null, txps);
  });
}

/**
 * Sign a transaction proposal
 *
 * @param {Object} txp [Required] - Transaction proposal.
 * @param {String} password [Optional] - A password to decrypt the encrypted private key (if encryption is set).
 * @return {Callback} cb - Return error or object
 */
API.prototype.signTxProposal = function(txp, password, cb) {
  $.checkState(this.device);
  $.checkState(this.copayer && this.copayer.isComplete());
  $.checkArgument(txp.creatorId);

  if (_.isFunction(password)) {
    cb = password;
    password = null;
  }

  var self = this;

  if (!txp.signatures) {
    if (!self.canSign())
      return cb(new Errors.MISSING_PRIVATE_KEY);

    if (self.isPrivKeyEncrypted() && !password)
      return cb(new Errors.ENCRYPTED_PRIVATE_KEY);
  }

  var signatures = txp.signatures;

  if (_.isEmpty(signatures)) {
    try {
      signatures = self._signTxp(txp, password);
    } catch (ex) {
      log.error('Error signing tx', ex);
      return cb(ex);
    }
  }

  var url = '/v1/txproposals/' + txp.id + '/signatures/';
  var args = {
    signatures: signatures
  };

  self._doPostRequest(url, args, function(err, txp) {
    if (err) return cb(err);
    self._processTxps(txp);
    return cb(null, txp);
  });
};

/**
 * Reject a transaction proposal
 *
 * @param {Object} txp [Required] - Transaction proposal.
 * @param {String} reason [Required] - Reject reason.
 * @return {Callback} cb - Return error or object
 */
API.prototype.rejectTxProposal = function(txp, reason, cb) {
  $.checkState(this.device);
  $.checkState(this.copayer && this.copayer.isComplete());
  $.checkArgument(cb);

  var self = this;

  var url = '/v1/txproposals/' + txp.id + '/rejections/';
  var args = {
    reason: API._encryptMessage(reason, self.copayer.sharedEncryptingKey) || '',
  };
  self._doPostRequest(url, args, function(err, txp) {
    if (err) return cb(err);
    self._processTxps(txp);
    return cb(null, txp);
  });
};

/**
 * Broadcast raw transaction
 *
 * @param {Object} opts
 * @param {String} opts.network [Optional] - defaults to 'livenet'.
 * @param {String} opts.joint [Required] - Raw joint data.
 * @return {Callback} cb - Return error or status
 */
API.prototype.broadcastRawTx = function(opts, cb) {
  $.checkState(this.device);
  $.checkState(this.copayer);
  $.checkArgument(cb);

  var self = this;

  opts = opts || {};

  var url = '/v1/broadcast_raw/';
  self._doPostRequest(url, opts, function(err, result) {
    if (err) return cb(err);
    return cb(null, result);
  });
};

API.prototype._doBroadcast = function(txp, cb) {
  var self = this;
  var url = '/v1/txproposals/' + txp.id + '/broadcast/';
  self._doPostRequest(url, {}, function(err, txp) {
    if (err) return cb(err);
    self._processTxps(txp);
    return cb(null, txp);
  });
};

/**
 * Broadcast a transaction proposal
 *
 * @param {Object} txp [Required] - Transaction proposal.
 * @return {Callback} cb - Return error or object
 */
API.prototype.broadcastTxProposal = function(txp, cb) {
  $.checkState(this.device);
  $.checkState(this.copayer && this.copayer.isComplete());

  var self = this;
  self._doBroadcast(txp, cb);
};

/**
 * Remove a transaction proposal
 *
 * @param {Object} txp [Required] - Transaction proposal.
 * @return {Callback} cb - Return error or empty
 */
API.prototype.removeTxProposal = function(txp, cb) {
  $.checkState(this.device);
  $.checkState(this.copayer && this.copayer.isComplete());

  var self = this;

  var url = '/v1/txproposals/' + txp.id;
  self._doDeleteRequest(url, function(err) {
    return cb(err);
  });
};

/**
 * Get transaction history
 *
 * @param {Object} opts
 * @param {String} opts.asset [Optional] - Asset unit. (defaults to null).
 * @param {Number} opts.limit [Optional] - (defaults to 10).
 * @param {Number} opts.lastRowId [Optional] - Retrieve transaction from this row id.
 * @return {Callback} cb - Return error or array of transactions
 */
API.prototype.getTxHistory = function(opts, cb) {
  $.checkState(this.device);
  $.checkState(this.copayer && this.copayer.isComplete());

  var self = this;
  var args = [];
  if (opts) {
    if (opts.asset) args.push('asset=' + opts.asset);
    if (opts.limit) args.push('limit=' + opts.limit);
    if (opts.lastRowId) args.push('lastRowId=' + opts.lastRowId);
  }
  var qs = '';
  if (args.length > 0) {
    qs = '?' + args.join('&');
  }

  var url = '/v1/txhistory/' + qs;
  self._doGetRequest(url, function(err, txs) {
    if (err) return cb(err);
    var txps = txs.filter(tx => tx.proposalId);
    self._processTxps(txps);
    return cb(null, txs);
  });
};

/**
 * Get one transaction
 *
 * @param {String} TransactionId
 * @return {Callback} cb - Return error or transaction
 */
API.prototype.getTx = function(id, cb) {
  $.checkState(this.device);
  $.checkState(this.copayer && this.copayer.isComplete());

  var self = this;
  var url = '/v1/txproposals/' + id;
  this._doGetRequest(url, function(err, txp) {
    if (err) return cb(err);

    self._processTxps(txp);
    return cb(null, txp);
  });
};

/**
 * Start an address scanning process.
 * When finished, the scanning process will send a notification 'ScanFinished' to all copayers.
 *
 * @param {Object} opts
 * @param {Boolean} opts.includeCopayerBranches [Optional] - (defaults to false)
 * @return {Callback} cb
 */
API.prototype.startScan = function(opts, cb) {
  $.checkState(this.device);
  $.checkState(this.copayer && this.copayer.isComplete());

  var self = this;

  opts.includeCopayerBranches = opts.includeCopayerBranches || false;

  var args = {
    includeCopayerBranches: opts.includeCopayerBranches,
  };

  self._doPostRequest('/v1/addresses/scan', args, function(err) {
    return cb(err);
  });
};

/**
 * Adds access to the current copayer
 * 
 * @param {Object} opts
 * @param {Boolean} opts.generateNewKey [Optional] - Generate a new key for the new access.
 * @param {String} opts.restrictions [Optional] - cannotProposeTXs, cannotXXX TODO.
 * @param {String} opts.name [Optional] - Name for the new access.
 *
 * @return {Callback} cb - Return error or the accesses Wallet and the requestPrivateKey
 */
API.prototype.addAccess = function(opts, cb) {
  $.checkState(this.device && this.device.canSign());
  $.checkState(this.copayer);

  opts = opts || {};

  var reqPrivKey = new Bitcore.PrivateKey(opts.generateNewKey ? null : this.device.requestPrivKey);
  var requestPubKey = reqPrivKey.toPublicKey().toString();

  var xPriv = new Bitcore.HDPrivateKey(this.device.xPrivKey)
    .deriveChild(this.device.getBaseDerivationPath(this.copayer.account));
  var sig = Utils.signRequestPubKey(requestPubKey, xPriv);
  var copayerId = this.copayer.copayerId;

  var encCopayerName = opts.name ? Utils.encryptMessage(opts.name, this.copayer.sharedEncryptingKey) : null;

  var opts = {
    copayerId: copayerId,
    requestPubKey: requestPubKey,
    signature: sig,
    name: encCopayerName,
    restrictions: opts.restrictions,
  };

  this._doPutRequest('/v1/copayers/' + copayerId + '/', opts, function(err, res) {
    if (err) return cb(err);
    return cb(null, res.wallet, reqPrivKey);
  });
};

/**
 * Get a note associated with the specified txid
 * 
 * @param {Object} opts
 * @param {String} opts.txid [Required] - The txid to associate this note with
 */
API.prototype.getTxNote = function(opts, cb) {
  $.checkState(this.device);
  $.checkState(this.copayer);

  var self = this;

  opts = opts || {};
  self._doGetRequest('/v1/txnotes/' + opts.txid + '/', function(err, note) {
    if (err) return cb(err);
    self._processTxNotes(note);
    return cb(null, note);
  });
};

/**
 * Edit a note associated with the specified txid
 * 
 * @param {Object} opts
 * @param {String} opts.txid [Required] - The txid to associate this note with
 * @param {String} opts.body [Required] - The contents of the note
 */
API.prototype.editTxNote = function(opts, cb) {
  $.checkState(this.device);
  $.checkState(this.copayer);

  var self = this;

  opts = opts || {};
  if (opts.body) {
    opts.body = API._encryptMessage(opts.body, this.copayer.sharedEncryptingKey);
  }
  self._doPutRequest('/v1/txnotes/' + opts.txid + '/', opts, function(err, note) {
    if (err) return cb(err);
    self._processTxNotes(note);
    return cb(null, note);
  });
};

/**
 * Get all notes edited after the specified date
 * 
 * @param {Object} opts
 * @param {String} opts.minTs [Optional] - The starting timestamp
 */
API.prototype.getTxNotes = function(opts, cb) {
  $.checkState(this.device);
  $.checkState(this.copayer);

  var self = this;

  opts = opts || {};
  var args = [];
  if (_.isNumber(opts.minTs)) {
    args.push('minTs=' + opts.minTs);
  }
  var qs = '';
  if (args.length > 0) {
    qs = '?' + args.join('&');
  }

  self._doGetRequest('/v1/txnotes/' + qs, function(err, notes) {
    if (err) return cb(err);
    self._processTxNotes(notes);
    return cb(null, notes);
  });
};

/**
 * Returns exchange rate for the specified currency & timestamp.
 * 
 * @param {Object} opts
 * @param {String} opts.code [Required] - Currency ISO code.
 * @param {Date} opts.ts [Optional] - A timestamp to base the rate on (default Date.now()).
 * @param {String} opts.provider [Optional] - A provider of exchange rates (default 'Bittrex').
 * @return {Object} rates - The exchange rate.
 */
API.prototype.getFiatRate = function(opts, cb) {
  $.checkArgument(cb);

  var self = this;

  var opts = opts || {};

  var args = [];
  if (opts.ts) args.push('ts=' + opts.ts);
  if (opts.provider) args.push('provider=' + opts.provider);
  var qs = '';
  if (args.length > 0) {
    qs = '?' + args.join('&');
  }

  self._doGetRequest('/v1/fiatrates/' + opts.code + '/' + qs, function(err, rates) {
    if (err) return cb(err);
    return cb(null, rates);
  });
}

/**
 * Returns assets metadata.
 * 
 * @param {Object} opts
 * @param {String} opts.asset [Optional] - Asset unit. (defaults for all assets).
 * @return {Object} assets - The assets metadata.
 */
API.prototype.getAssets = function(opts, cb) {
  $.checkArgument(cb);

  var self = this;
  var opts = opts || {};
  var args = [];
  if (opts.asset) args.push('asset=' + opts.asset);
  var qs = '';
  if (args.length > 0) {
    qs = '?' + args.join('&');
  }

  self._doGetRequest('/v1/assets/'+ qs, function(err, assets) {
    if (err) return cb(err);
    return cb(null, assets);
  });
}

/**
 * Subscribe to push notifications.
 * 
 * @param {Object} opts
 * @param {String} opts.type [Required] - Device type (ios or android).
 * @param {String} opts.token [Required] - Device token.
 * @return {Object} response - Status of subscription.
 */
API.prototype.pushNotificationsSubscribe = function(opts, cb) {
  var url = '/v1/pushnotifications/subscriptions/';
  this._doPostRequest(url, opts, function(err, response) {
    if (err) return cb(err);
    return cb(null, response);
  });
};

/**
 * Unsubscribe from push notifications.
 * 
 * @param {String} token [Required] - Device token
 * @return {Callback} cb - Return error if exists
 */
API.prototype.pushNotificationsUnsubscribe = function(token, cb) {
  var url = '/v2/pushnotifications/subscriptions/' + token;
  this._doDeleteRequest(url, cb);
};

/**
 * Listen to a tx for its first confirmation.
 * 
 * @param {Object} opts
 * @param {String} opts.txid [Required] - The txid to subscribe to.
 * @return {Object} response - Status of subscription.
 */
API.prototype.txConfirmationSubscribe = function(opts, cb) {
  var url = '/v1/txconfirmations/';
  this._doPostRequest(url, opts, function(err, response) {
    if (err) return cb(err);
    return cb(null, response);
  });
};

/**
 * Stop listening for a tx confirmation.
 * 
 * @param {String} txid [Required] - The txid to unsubscribe from.
 * @return {Callback} cb - Return error if exists
 */
API.prototype.txConfirmationUnsubscribe = function(txid, cb) {
  var url = '/v1/txconfirmations/' + txid;
  this._doDeleteRequest(url, cb);
};

/**
 * Get wallet status based on a string identifier (one of: walletId, address, txid)
 *
 * @param {String} opts.identifier [Required] - The identifier
 * @param {Boolean} opts.includeExtendedInfo [Optional] - Query extended status
 * @return {Callback} cb - Returns error or an object with status information
 */
API.prototype.getStatusByIdentifier = function(opts, cb) {
  $.checkState(this.device);
  $.checkState(this.copayer);

  var self = this;
  opts = opts || {};

  var qs = [];
  qs.push('includeExtendedInfo=' + (opts.includeExtendedInfo ? '1' : '0'));
  qs.push('walletCheck=' + (opts.walletCheck ? '1' : '0'));

  self._doGetRequest('/v1/wallets/' + opts.identifier + '?' + qs.join('&'), function(err, result) {
    if (err || !result || !result.wallet) return cb(err);
    if (result.wallet.status == 'pending') {
      var d = self.device;
      var c = self.copayer;
      result.wallet.secret = API._buildSecret(c.walletId, c.walletPrivKey, d.coin, d.network);
    }

    self._processStatus(result);

    return cb(err, result);
  });
};

/**
 * Get wallet id and pubic key based on address
 *
 * @param {String} address [Required] - The address
 * @return {Callback} cb - Returns error or an object with wallet id and public key
 */
API.prototype.getWalletByAddress = function(address, cb) {
  $.checkState(this.device);
  $.checkState(this.copayer);
  $.checkArgument(address);

  var self = this;

  self._doGetRequest('/v1/wallet/' + address, function(err, result) {
    if (err) return cb(err);
    return cb(null, result);
  });
};

/**  
 * Create a message sent to other copayer  
 * @param {Object} opts
 * @param {String} opts.data [Required] - The encrypted data sent to other copayer. 
 * @param {String} opts.fromAddress [Required] - The message sender.
 * @param {String} opts.fromWalletId [Required] - The sender's wallet id. 
 * @param {String} opts.fromPubKey [Required] - The sender's public key.
 * @param {String} opts.toAddress [Required] - The message receiver.  
 * @param {String} opts.toWalletId [Required] - The receiver's wallet id.  
 * @param {String} opts.toPubKey [Required] - The receiver's public key. 
 * 
 * @returns {Object} Message  
 */
API.prototype.createMessage = function(opts, cb) {
  $.checkState(this.device);
  $.checkState(this.copayer);
  $.checkArgument(opts);

  var self = this;
  var url = '/v1/messages/';
  self._doPostRequest(url, opts, function(err, response) {
    if (err) return cb(err);
    return cb(null, response);
  });
};

/**
 * Fetch messages
 * @param {Object} opts
 * @param {String} opts.direction [Required] - Indicate 'send' or 'receive' messages.
 * @param {String} opts.lastMessageId [Optional] - Get messages before this message id.
 * @param {String} opts.limit [Optional] - The size of the result set.
 *
 * @returns {Array} List of messages
 */
API.prototype.getMessages = function(opts, cb) {
  $.checkState(this.device);
  $.checkState(this.copayer);
  $.checkArgument(opts);
  $.checkArgument(opts.direction);

  var self = this;  

  var url = '/v1/messages/';
  url += '?direction=' + opts.direction;
  if (opts.messageId) {
    url += '&lastMessageId=' + opts.lastMessageId;
  }
  if (opts.limit) {
    url += '&limit=' + opts.limit;
  }

  self._doGetRequest(url, function(err, result) {
    if (err) return cb(err);
    return cb(null, result);
  });
}

module.exports = API;
