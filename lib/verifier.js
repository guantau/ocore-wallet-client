var $ = require('preconditions').singleton();
var _ = require('lodash');

var Bitcore = require('bitcore-lib');

var Common = require('./common');
var Utils = Common.Utils;

var log = require('./log');

/**
 * @desc Verifier constructor. Checks data given by the server
 *
 * @constructor
 */
function Verifier(opts) {};

/**
 * Check address
 *
 * @param {Function} copayer
 * @param {String} address
 * @returns {Boolean} true or false
 */
Verifier.checkAddress = function(copayer, address) {
  $.checkState(copayer.isComplete());

  var local = Utils.deriveAddress(copayer.walletId, address.type || copayer.addressType, copayer.publicKeyRing, address.path, copayer.m);
  return (local.address == address.address);
};

/**
 * Check copayers
 *
 * @param {Function} copayer
 * @param {Array} copayers
 * @returns {Boolean} true or false
 */
Verifier.checkCopayers = function(copayer, copayers) {
  $.checkState(copayer.walletPrivKey);
  var walletPubKey = Bitcore.PrivateKey.fromString(copayer.walletPrivKey).toPublicKey().toString();

  if (copayers.length != copayer.n) {
    log.error('Missing public keys in server response');
    return false;
  }

  // Repeated xpub kes?
  var uniq = [];
  var error;
  _.each(copayers, function(copayer) {
    if (error) return;

    if (uniq[copayers.xPubKey]++) {
      log.error('Repeated public keys in server response');
      error = true;
    }

    // Not signed pub keys
    if (!(copayer.encryptedName || copayer.name) || !copayer.xPubKey || !copayer.requestPubKey || !copayer.signature) {
      log.error('Missing copayer fields in server response');
      error = true;
    } else {
      var hash = Utils.getCopayerHash(copayer.encryptedName || copayer.name, copayer.xPubKey, copayer.requestPubKey);
      if (!Utils.verifyMessage(hash, copayer.signature, walletPubKey)) {
        log.error('Invalid signatures in server response');
        error = true;
      }
    }
  });

  if (error) return false;

  if (!_.includes(_.map(copayers, 'xPubKey'), copayer.xPubKey)) {
    log.error('Server response does not contains our public keys')
    return false;
  }
  return true;
};

Verifier.checkProposalCreation = function(args, txp, encryptingKey) {
  function strEqual(str1, str2) {
    return ((!str1 && !str2) || (str1 === str2));
  }

  if (args.app == 'payment') {
    if (args.params.send_all) {
      if (args.params.outputs[0].address != txp.params.outputs[0].address) {
        return false;
      } else {
        return true;
      }
    }

    var changeAddress;
    if (txp.params.change_address) {
      changeAddress = txp.params.change_address;
    }
    if (args.params.change_address && !strEqual(changeAddress, args.params.change_address)) return false;

    var outputs = _.cloneDeep(txp.params.outputs);
    for (var i = 0; i < args.params.outputs.length; i++) {
      var output = args.params.outputs[i];
      var ret = outputs.find(item => strEqual(output.address, item.address) && output.amount == item.amount);
      if (!ret) return false;
      outputs.splice(ret, 1);
    }
    if (txp.params.change_address && outputs.length != 1) return false;
    if (!txp.params.change_address && outputs.length != 0) return false;
  }

  var decryptedMessage = null;
  try {
    decryptedMessage = Utils.decryptMessage(args.message, encryptingKey);
  } catch (e) {
    return false;
  }
  if (!strEqual(txp.message, decryptedMessage)) return false;
  if ((args.customData || txp.customData) && !_.isEqual(txp.customData, args.customData)) return false;

  return true;
};


module.exports = Verifier;
