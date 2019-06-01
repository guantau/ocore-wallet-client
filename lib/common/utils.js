'use strict';

var _ = require('lodash');
var $ = require('preconditions').singleton();
var sjcl = require('sjcl');
var Stringify = require('json-stable-stringify');

var Bitcore = require('bitcore-lib');
var PrivateKey = Bitcore.PrivateKey;
var PublicKey = Bitcore.PublicKey;
var crypto = Bitcore.crypto;
var encoding = Bitcore.encoding;

var Constants = require('./constants');
var Defaults = require('./defaults');
var ObjectHash = require('./object_hash');

function Utils() {};

Utils.SJCL = {};

Utils.encryptMessage = function(message, encryptingKey) {
  var key = sjcl.codec.base64.toBits(encryptingKey);
  return sjcl.encrypt(key, message, _.defaults({
    ks: 128,
    iter: 1,
  }, Utils.SJCL));
};

// Will throw if it can't decrypt
Utils.decryptMessage = function(cyphertextJson, encryptingKey) {
  if (!cyphertextJson) return;

  if (!encryptingKey)
    throw 'No key';

  var key = sjcl.codec.base64.toBits(encryptingKey);
  return sjcl.decrypt(key, cyphertextJson);
};

Utils.decryptMessageNoThrow = function(cyphertextJson, encryptingKey) {
  function isJsonString(str) {
    var r;
    try {
      r=JSON.parse(str);
    } catch (e) {
      return false;
    }
    return r;
  }

  if (!encryptingKey)
    return '<ECANNOTDECRYPT>';

  if (!cyphertextJson)
    return '';

  // no sjcl encrypted json
  var r= isJsonString(cyphertextJson);
  if (!r|| !r.iv || !r.ct) {
    return cyphertextJson;
  }

  try {
    return Utils.decryptMessage(cyphertextJson, encryptingKey);
  } catch (e) {
    return '<ECANNOTDECRYPT>';
  }
};

/* TODO: It would be nice to be compatible with bitcoind signmessage. How
 * the hash is calculated there? */
Utils.hashMessage = function(text) {
  $.checkArgument(text);
  var buf = new Buffer(text);
  var ret = crypto.Hash.sha256sha256(buf);
  ret = new Bitcore.encoding.BufferReader(ret).readReverse();
  return ret;
};

Utils.signMessage = function(text, privKey) {
  $.checkArgument(text);
  var priv = new PrivateKey(privKey);
  var hash = Utils.hashMessage(text);
  return crypto.ECDSA.sign(hash, priv, 'little').toString();
};

Utils.verifyMessage = function(text, signature, pubKey) {
  $.checkArgument(text);
  $.checkArgument(pubKey);

  if (!signature)
    return false;

  var pub = new PublicKey(pubKey);
  var hash = Utils.hashMessage(text);

  try {
    var sig = new crypto.Signature.fromString(signature);
    return crypto.ECDSA.verify(hash, sig, pub, 'little');
  } catch (e) {
    return false;
  }
};

Utils.privateKeyToAESKey = function(privKey) {
  $.checkArgument(privKey && _.isString(privKey));
  $.checkArgument(Bitcore.PrivateKey.isValid(privKey), 'The private key received is invalid');
  var pk = Bitcore.PrivateKey.fromString(privKey);
  return Bitcore.crypto.Hash.sha256(pk.toBuffer()).slice(0, 16).toString('base64');
};

Utils.getCopayerHash = function(name, xPubKey, requestPubKey) {
  return [name, xPubKey, requestPubKey].join('|');
};

Utils.deriveAddress = function(walletId, addressType, publicKeyRing, path, m) {
  $.checkArgument(_.includes(_.values(Constants.ADDRESS_TYPES), addressType));

  var publicKeys = _.map(publicKeyRing, function(item) {
    var xpub = new Bitcore.HDPublicKey(item.xPubKey);
    return xpub.deriveChild(path).publicKey;
  });

  var address, definition;
  var signingPaths = {};
  switch (addressType) {
    case Constants.ADDRESS_TYPES.NORMAL:
      $.checkState(_.isArray(publicKeys) && publicKeys.length == 1);
	    var pubkey = publicKeys[0].toBuffer().toString("base64");
      definition = ["sig", {"pubkey": pubkey}];
      signingPaths[pubkey] = 'r';
      address = ObjectHash.getChash160(definition);
      break;
    case Constants.ADDRESS_TYPES.SHARED:
      var set = [];
      publicKeys.forEach((item, ind) => {
        var pubkey = item.toBuffer().toString("base64");
        set.push(["sig", {"pubkey": pubkey}]);
        signingPaths[pubkey] = 'r.' + ind;
      });
      definition = [ "r of set", { "required": m, "set": set } ];
	    address = ObjectHash.getChash160(definition);
      break;
  }

  return {
    address: address,
    definition: definition,
    path: path,
    signingPaths: signingPaths,
    walletId: walletId,
  };
};

Utils.xPubToCopayerId = function(xpub) {
  var cryptoHash = require('crypto');
  var id = cryptoHash.createHash("sha256").update(xpub, "utf8").digest("base64");
  return id;
};

Utils.xPriToDeviceId = function(xpri) {
  var devicePrivKey = xpri.derive(Constants.PATHS.DEVICE_KEY);
  var pubkey = devicePrivKey.privateKey.toPublicKey().toBuffer().toString('base64');
  var id = '0' + ObjectHash.getChash160(pubkey);
  return id;
}

Utils.pubToDeviceId = function(pub) {
  var pubkey = Buffer.from(pub, 'hex').toString('base64');
  var id = '0' + ObjectHash.getChash160(pubkey);
  return id;
}

Utils.signRequestPubKey = function(requestPubKey, xPrivKey) {
  var priv = new Bitcore.HDPrivateKey(xPrivKey).deriveChild(Constants.PATHS.REQUEST_KEY_AUTH).privateKey;
  return Utils.signMessage(requestPubKey, priv);
};

Utils.verifyRequestPubKey = function(requestPubKey, signature, xPubKey) {
  var pub = (new Bitcore.HDPublicKey(xPubKey)).deriveChild(Constants.PATHS.REQUEST_KEY_AUTH).publicKey;
  return Utils.verifyMessage(requestPubKey, signature, pub.toString());
};

Utils.formatAmount = function(bytes, unit, opts) {
  $.shouldBeNumber(bytes);
  $.checkArgument(_.includes(_.keys(Constants.UNITS), unit));

  function clipDecimals(number, decimals) {
    var x = number.toString().split('.');
    var d = (x[1] || '0').substring(0, decimals);
    return parseFloat(x[0] + '.' + d);
  };

  function addSeparators(nStr, thousands, decimal, minDecimals) {
    nStr = nStr.replace('.', decimal);
    var x = nStr.split(decimal);
    var x0 = x[0];
    var x1 = x[1];

    x1 = _.dropRightWhile(x1, function(n, i) {
      return n == '0' && i >= minDecimals;
    }).join('');
    var x2 = x.length > 1 ? decimal + x1 : '';

    x0 = x0.replace(/\B(?=(\d{3})+(?!\d))/g, thousands);
    return x0 + x2;
  };

  opts = opts || {};

  var u = Constants.UNITS[unit];
  var precision = opts.fullPrecision ? 'full' : 'short';
  var amount = clipDecimals((bytes / u.toBytes), u[precision].maxDecimals).toFixed(u[precision].maxDecimals);
  return addSeparators(amount, opts.thousandsSeparator || ',', opts.decimalSeparator || '.', u[precision].minDecimals);
};


module.exports = Utils;
