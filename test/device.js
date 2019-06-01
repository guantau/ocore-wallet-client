'use strict';

var _ = require('lodash');
var chai = chai || require('chai');
var sinon = sinon || require('sinon');
var should = chai.should();

var Constants = require('../lib/common/constants');
var Device = require('../lib/device');

describe('Device', function() {

  describe('#create', function() {
    it('Should create', function() {
      var d = Device.create('obyte', 'livenet');
      should.exist(d.xPrivKey);
      should.exist(d.deviceId);
    });

    it('Should create random', function() {
      var all = {};
      for (var i = 0; i < 10; i++) {
        var d = Device.create('obyte', 'livenet');
        var exist = all[d.xPrivKey];
        should.not.exist(exist);
        all[d.xPrivKey] = 1;
      }
    });
  });

  describe('#getBaseDerivationPath', function() {
    it('should return path for livenet', function() {
      var d = Device.create('obyte', 'livenet');
      var path = d.getBaseDerivationPath(0);
      path.should.equal("m/44'/0'/0'");
    });
    it('should return path for testnet account 2', function() {
      var d = Device.create('obyte', 'testnet');
      var path = d.getBaseDerivationPath(2);
      path.should.equal("m/44'/1'/2'");
    });
    it('should return path for BIP45', function() {
      var d = Device.create('obyte', 'livenet');
      d.derivationStrategy = Constants.DERIVATION_STRATEGIES.BIP45;
      var path = d.getBaseDerivationPath(0);
      path.should.equal("m/45'");
    });
  });

  describe('#getDerivedXPrivKey', function() {
    it('should derive extended private key from master livenet', function() {
      var d = Device.fromExtendedPrivateKey('obyte', 'xprv9s21ZrQH143K3zLpjtB4J4yrRfDTEfbrMa9vLZaTAv5BzASwBmA16mdBmZKpMLssw1AzTnm31HAD2pk2bsnZ9dccxaLD48mRdhtw82XoiBi', 'BIP44');
      var xpk = d.getDerivedXPrivKey(0).toString();
      xpk.should.equal('xprv9xud2WztGSSBPDPDL9RQ3rG3vucRA4BmEnfAdP76bTqtkGCK8VzWjevLw9LsdqwH1PEWiwcjymf1T2FLp12XjwjuCRvcSBJvxDgv1BDTbWY');
    });
    it('should derive extended private key from master testnet', function() {
      var d = Device.fromExtendedPrivateKey('obyte', 'tprv8ZgxMBicQKsPfPX8avSJXY1tZYJJESNg8vR88i8rJFkQJm6HgPPtDEmD36NLVSJWV5ieejVCK62NdggXmfMEHog598PxvXuLEsWgE6tKdwz', 'BIP44');
      var xpk = d.getDerivedXPrivKey(0).toString();
      xpk.should.equal('tprv8gBu8N7JbHZs7MsW4kgE8LAYMhGJES9JP6DHsj2gw9Tc5PrF5Grr9ynAZkH1LyWsxjaAyCuEMFKTKhzdSaykpqzUnmEhpLsxfujWHA66N93');
    });
    it('should derive extended private key from master BIP48 livenet', function() {
      var d = Device.fromExtendedPrivateKey('obyte', 'xprv9s21ZrQH143K3zLpjtB4J4yrRfDTEfbrMa9vLZaTAv5BzASwBmA16mdBmZKpMLssw1AzTnm31HAD2pk2bsnZ9dccxaLD48mRdhtw82XoiBi', 'BIP48');
      var xpk = d.getDerivedXPrivKey(0).toString();
      xpk.should.equal('xprv9yaGCLKPS2ovEGw987MZr4DCkfZHGh518ndVk3Jb6eiUdPwCQu7nYru59WoNkTEQvmhnv5sPbYxeuee5k8QASWRnGV2iFX4RmKXEQse8KnQ');
    });
    it('should derive extended private key from master livenet (BIP45)', function() {
      var d = Device.fromExtendedPrivateKey('obyte', 'xprv9s21ZrQH143K3zLpjtB4J4yrRfDTEfbrMa9vLZaTAv5BzASwBmA16mdBmZKpMLssw1AzTnm31HAD2pk2bsnZ9dccxaLD48mRdhtw82XoiBi', 'BIP45');
      var xpk = d.getDerivedXPrivKey(0).toString();
      xpk.should.equal('xprv9vDaAbbvT8LHKr8v5A2JeFJrnbQk6ZrMDGWuiv2vZgSyugeV4RE7Z9QjBNYsdafdhwEGb6Y48DRrXFVKvYRAub9ExzcmJHt6Js6ybJCSssm');
    });
  });

  describe('#fromExtendedPrivateKey', function() {
    it('Should create from seed', function() {
      var xPriv = 'xprv9s21ZrQH143K2TjT3rF4m5AJcMvCetfQbVjFEx1Rped8qzcMJwbqxv21k3ftL69z7n3gqvvHthkdzbW14gxEFDYQdrRQMub3XdkJyt3GGGc';
      var d = Device.fromExtendedPrivateKey('obyte', xPriv, 'BIP44');
      d.xPrivKey.should.equal('xprv9s21ZrQH143K2TjT3rF4m5AJcMvCetfQbVjFEx1Rped8qzcMJwbqxv21k3ftL69z7n3gqvvHthkdzbW14gxEFDYQdrRQMub3XdkJyt3GGGc');
      d.xPubKey.should.equal('xpub661MyMwAqRbcEwov9sn58D73APkh4MPFxier3LR3NzA7inwVrUv6WiLVbHdqtQB14A3YL3oH4KFwaA8iHyZDnnWUtT9cVnUd5Avo6GCJs2G');
      d.network.should.equal('livenet');
      d.personalEncryptingKey.should.equal('M4MTmfRZaTtX6izAAxTpJg==');
      var d = d.addCopayer(0);
      d.copayerId.should.equal('utZu+IrY3sCONtV2wptPCR0wGX8E4WaHHmS/lp0IqVg=');
      should.not.exist(d.walletPrivKey);
    });

    it('Should create from seed and walletPrivateKey', function() {
      var xPriv = 'xprv9s21ZrQH143K2TjT3rF4m5AJcMvCetfQbVjFEx1Rped8qzcMJwbqxv21k3ftL69z7n3gqvvHthkdzbW14gxEFDYQdrRQMub3XdkJyt3GGGc';
      var wKey = 'a28840e18650b1de8cb83bcd2213672a728be38a63e70680b0d2be9c452e2d4d';
      var d = Device.fromExtendedPrivateKey('obyte', xPriv, 'BIP44');
      d.xPrivKey.should.equal('xprv9s21ZrQH143K2TjT3rF4m5AJcMvCetfQbVjFEx1Rped8qzcMJwbqxv21k3ftL69z7n3gqvvHthkdzbW14gxEFDYQdrRQMub3XdkJyt3GGGc');
      var d = d.addCopayer(0, {walletPrivKey: 'a28840e18650b1de8cb83bcd2213672a728be38a63e70680b0d2be9c452e2d4d'})
      d.walletPrivKey.should.equal(wKey);
    });
  });

  describe('#fromMnemonic', function() {
    it('Should create from mnemonic BIP44', function() {
      var words = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
      var d = Device.fromMnemonic('obyte', 'livenet', words, '', 'BIP44');
      d.xPrivKey.should.equal('xprv9s21ZrQH143K3GJpoapnV8SFfukcVBSfeCficPSGfubmSFDxo1kuHnLisriDvSnRRuL2Qrg5ggqHKNVpxR86QEC8w35uxmGoggxtQTPvfUu');
      d.network.should.equal('livenet');
      d.derivationStrategy.should.equal('BIP44');
      d.xPubKey.should.equal('xpub661MyMwAqRbcFkPHucMnrGNzDwb6teAX1RbKQmqtEF8kK3Z7LZ59qafCjB9eCRLiTVG3uxBxgKvRgbubRhqSKXnGGb1aoaqLrpMBDrVxga8');
      d.getBaseDerivationPath(0).should.equal("m/44'/0'/0'");
    });

    it('Should create from mnemonic BIP48', function() {
      var words = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
      var d = Device.fromMnemonic('obyte', 'livenet', words, '', 'BIP48');
      d.xPrivKey.should.equal('xprv9s21ZrQH143K3GJpoapnV8SFfukcVBSfeCficPSGfubmSFDxo1kuHnLisriDvSnRRuL2Qrg5ggqHKNVpxR86QEC8w35uxmGoggxtQTPvfUu');
      d.network.should.equal('livenet');
      d.derivationStrategy.should.equal('BIP48');
      d.xPubKey.should.equal('xpub661MyMwAqRbcFkPHucMnrGNzDwb6teAX1RbKQmqtEF8kK3Z7LZ59qafCjB9eCRLiTVG3uxBxgKvRgbubRhqSKXnGGb1aoaqLrpMBDrVxga8');
      d.getBaseDerivationPath(0).should.equal("m/48'/0'/0'");
    });

    it('Should create from mnemonic account 1', function() {
      var words = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
      var d = Device.fromMnemonic('obyte', 'livenet', words, '', 'BIP44');
      d.xPrivKey.should.equal('xprv9s21ZrQH143K3GJpoapnV8SFfukcVBSfeCficPSGfubmSFDxo1kuHnLisriDvSnRRuL2Qrg5ggqHKNVpxR86QEC8w35uxmGoggxtQTPvfUu');
      d.xPubKey.should.equal('xpub661MyMwAqRbcFkPHucMnrGNzDwb6teAX1RbKQmqtEF8kK3Z7LZ59qafCjB9eCRLiTVG3uxBxgKvRgbubRhqSKXnGGb1aoaqLrpMBDrVxga8');
      d.getBaseDerivationPath(1).should.equal("m/44'/0'/1'");
    });

    it('Should create from mnemonic with undefined/null passphrase', function() {
      var words = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
      var d = Device.fromMnemonic('obyte', 'livenet', words, undefined, 'BIP44');
      d.xPrivKey.should.equal('xprv9s21ZrQH143K3GJpoapnV8SFfukcVBSfeCficPSGfubmSFDxo1kuHnLisriDvSnRRuL2Qrg5ggqHKNVpxR86QEC8w35uxmGoggxtQTPvfUu');
      d = Device.fromMnemonic('obyte', 'livenet', words, null, 'BIP44');
      d.xPrivKey.should.equal('xprv9s21ZrQH143K3GJpoapnV8SFfukcVBSfeCficPSGfubmSFDxo1kuHnLisriDvSnRRuL2Qrg5ggqHKNVpxR86QEC8w35uxmGoggxtQTPvfUu');
    });

    it('Should create from mnemonic and passphrase', function() {
      var words = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
      var d = Device.fromMnemonic('obyte', 'livenet', words, 'húngaro', 'BIP44');
      d.xPrivKey.should.equal('xprv9s21ZrQH143K2LkGEPHqW8w5vMJ3giizin94rFpSM5Ys5KhDaP7Hde3rEuzC7VpZDtNX643bJdvhHnkbhKMNmLx3Yi6H8WEsHBBox3qbpqq');
    });

    it('Should create from mnemonic and passphrase for testnet account 2', function() {
      var words = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
      var d = Device.fromMnemonic('obyte', 'testnet', words, 'húngaro', 'BIP44');
      d.xPrivKey.should.equal('tprv8ZgxMBicQKsPd9yntx9LfnZ5EUiFvEm14L4BigEtq43LrvSJZkT39PRJA69r7sCsbKuJ69fMTzWVkeJLpXhKaQDe5MJanrxvCGwEPnNxN85');
      d.network.should.equal('testnet');
      d.xPubKey.should.equal('tpubD6NzVbkrYhZ4Wd1anbow5CDBoWEC5Zwuddey1CHCFKqjhQh5C9GdKt3ALExMkCDMRzixRyieG619hVi3ErHx3AdNiTuVvapTKuPiLDGdfi7');
      d.getBaseDerivationPath(2).should.equal("m/44'/1'/2'");
    });

    it('Should create from mnemonic (ES)', function() {
      var words = 'afirmar diseño hielo fideo etapa ogro cambio fideo toalla pomelo número buscar';
      var d = Device.fromMnemonic('obyte', 'livenet', words, '', 'BIP44');
      d.xPrivKey.should.equal('xprv9s21ZrQH143K3H3WtXCn9nHtpi7Fz1ZE9VJErWErhrGL4hV1cApFVo3t4aANoPF7ufcLLWqN168izu3xGQdLaGxXG2qYZF8wWQGNWnuSSon');
      d.network.should.equal('livenet');
    });
  });

  describe('#createWithMnemonic', function() {
    it('Should create credentials with mnemonic', function() {
      var d = Device.createWithMnemonic('obyte', 'livenet', '', 'en');
      should.exist(d.mnemonic);
      d.mnemonic.split(' ').length.should.equal(12);
      d.network.should.equal('livenet');
    });

    it('Should create credentials with mnemonic (testnet)', function() {
      var d = Device.createWithMnemonic('obyte', 'testnet', '', 'en');
      should.exist(d.mnemonic);
      d.mnemonic.split(' ').length.should.equal(12);
      d.network.should.equal('testnet');
    });

    it('Should return and clear mnemonic', function() {
      var d = Device.createWithMnemonic('obyte', 'testnet', '', 'en');
      should.exist(d.mnemonic);
      d.getMnemonic().split(' ').length.should.equal(12);
      d.clearMnemonic();
      should.not.exist(d.getMnemonic());
    });
  });

  describe('#createWithMnemonic #fromMnemonic roundtrip', function() {
    _.each(['en', 'es', 'ja', 'zh', 'fr'], function(lang) {
      it('Should verify roundtrip create/from with ' + lang + '/passphrase', function() {
        var d = Device.createWithMnemonic('obyte', 'testnet', 'holamundo', lang);
        should.exist(d.mnemonic);
        var words = d.mnemonic;
        var xPriv = d.xPrivKey;
        var path = d.getBaseDerivationPath(0);

        var d2 = Device.fromMnemonic('obyte', 'testnet', words, 'holamundo', 'BIP44');
        should.exist(d2.mnemonic);
        words.should.be.equal(d2.mnemonic);
        d2.xPrivKey.should.equal(d.xPrivKey);
        d2.network.should.equal(d.network);
        d2.getBaseDerivationPath(0).should.equal(path);
      });
    });

    it('Should fail roundtrip create/from with ES/passphrase with wrong passphrase', function() {
      var d = Device.createWithMnemonic('obyte', 'testnet', 'holamundo', 'es');
      should.exist(d.mnemonic);
      var words = d.mnemonic;
      var xPriv = d.xPrivKey;
      var path = d.getBaseDerivationPath(0);

      var d2 = Device.fromMnemonic('obyte', 'testnet', words, 'chaumundo', 'BIP44');
      d2.network.should.equal(d.network);
      d2.getBaseDerivationPath(0).should.equal(path);
      d2.xPrivKey.should.not.equal(d.xPrivKey);
    });
  });

  describe('Private key encryption', function() {
    describe('#encryptPrivateKey', function() {
      it('should encrypt private key and remove cleartext', function() {
        var d = Device.createWithMnemonic('obyte', 'livenet', '', 'en');
        d.encryptPrivateKey('password');
        d.isPrivKeyEncrypted().should.be.true;
        should.exist(d.xPrivKeyEncrypted);
        should.exist(d.mnemonicEncrypted);
        should.not.exist(d.xPrivKey);
        should.not.exist(d.mnemonic);
      });
      it('should fail to encrypt private key if already encrypted', function() {
        var d = Device.create('obyte', 'livenet');
        d.encryptPrivateKey('password');
        var err;
        try {
          d.encryptPrivateKey('password');
        } catch (ex) {
          err = ex;
        }
        should.exist(err);
      });
    });
    describe('#decryptPrivateKey', function() {
      it('should decrypt private key', function() {
        var d = Device.createWithMnemonic('obyte', 'livenet', '', 'en');
        d.encryptPrivateKey('password');
        d.isPrivKeyEncrypted().should.be.true;
        d.decryptPrivateKey('password');
        d.isPrivKeyEncrypted().should.be.false;
        should.exist(d.xPrivKey);
        should.exist(d.mnemonic);
        should.not.exist(d.xPrivKeyEncrypted);
        should.not.exist(d.mnemonicEncrypted);
      });
      it('should fail to decrypt private key with wrong password', function() {
        var d = Device.createWithMnemonic('obyte', 'livenet', '', 'en');
        d.encryptPrivateKey('password');

        var err;
        try {
          d.decryptPrivateKey('wrong');
        } catch (ex) {
          err = ex;
        }
        should.exist(err);
        d.isPrivKeyEncrypted().should.be.true;
        should.exist(d.mnemonicEncrypted);
        should.not.exist(d.mnemonic);
      });
      it('should fail to decrypt private key when not encrypted', function() {
        var d = Device.create('obyte', 'livenet');

        var err;
        try {
          d.decryptPrivateKey('password');
        } catch (ex) {
          err = ex;
        }
        should.exist(err);
        d.isPrivKeyEncrypted().should.be.false;
      });
    });
    describe('#getKeys', function() {
      it('should get keys regardless of encryption', function() {
        var d = Device.createWithMnemonic('obyte', 'livenet', '', 'en');
        var keys = d.getKeys();
        should.exist(keys);
        should.exist(keys.xPrivKey);
        should.exist(keys.mnemonic);
        keys.xPrivKey.should.equal(d.xPrivKey);
        keys.mnemonic.should.equal(d.mnemonic);

        d.encryptPrivateKey('password');
        d.isPrivKeyEncrypted().should.be.true;
        var keys2 = d.getKeys('password');
        should.exist(keys2);
        keys2.should.deep.equal(keys);

        d.decryptPrivateKey('password');
        d.isPrivKeyEncrypted().should.be.false;
        var keys3 = d.getKeys();
        should.exist(keys3);
        keys3.should.deep.equal(keys);
      });
      it('should get derived keys regardless of encryption', function() {
        var d = Device.createWithMnemonic('obyte', 'livenet', '', 'en');
        var xPrivKey = d.getDerivedXPrivKey(0);
        should.exist(xPrivKey);

        d.encryptPrivateKey('password');
        d.isPrivKeyEncrypted().should.be.true;
        var xPrivKey2 = d.getDerivedXPrivKey(0, 'password');
        should.exist(xPrivKey2);

        xPrivKey2.toString('hex').should.equal(xPrivKey.toString('hex'));

        d.decryptPrivateKey('password');
        d.isPrivKeyEncrypted().should.be.false;
        var xPrivKey3 = d.getDerivedXPrivKey(0);
        should.exist(xPrivKey3);
        xPrivKey3.toString('hex').should.equal(xPrivKey.toString('hex'));
      });
    });
  });
});
