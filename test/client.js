"use strict";

var _ = require("lodash");
var $ = require("preconditions").singleton();
var chai = require("chai");
chai.config.includeStack = true;
var sinon = require("sinon");
var should = chai.should();
var async = require("async");
var Uuid = require("uuid");
var sjcl = require("sjcl");

var Bitcore = require("bitcore-lib");

var OWS = require("ocore-wallet-service");
var ExpressApp = OWS.ExpressApp;
var Storage = OWS.Storage;

var Common = require("../lib/common");
var Constants = Common.Constants;
var Utils = Common.Utils;
var Client = require("../lib");
var Errors = require("../lib/errors");
var log = require("../lib/log");

var helpers = require("./helpers");
var blockchainExplorerMock = require("./blockchainexplorer");

var db;
describe("client API", function() {
  var clients, app, sandbox;
  var i = 0;

  before(done => {
    helpers.newDb("", (err, in_db) => {
      db = in_db;
      return done(err);
    });
  });

  beforeEach(function(done) {
    var storage = new Storage({
      db: db
    });
    var expressApp = new ExpressApp();
    expressApp.start(
      {
        ignoreRateLimiter: true,
        storage: storage,
        blockchainExplorer: blockchainExplorerMock,
        disableLogs: true
      },
      function() {
        app = expressApp.app;

        // Generates 5 clients
        clients = _.map(_.range(5), function(i) {
          return helpers.newClient(app);
        });
        blockchainExplorerMock.reset();
        sandbox = sinon.createSandbox();

        if (!process.env.OWC_SHOW_LOGS) {
          sandbox.stub(log, "warn");
          sandbox.stub(log, "info");
          sandbox.stub(log, "error");
        }
        done();
      }
    );
  });

  afterEach(function(done) {
    sandbox.restore();
    done();
  });

  describe("constructor", function() {
    it("should set the log level based on the logLevel option", function() {
      var originalLogLevel = log.level;

      var client = new Client({
        logLevel: "info"
      });
      client.logLevel.should.equal("info");
      log.level.should.equal("info");

      var client = new Client({
        logLevel: "debug"
      });
      client.logLevel.should.equal("debug");
      log.level.should.equal("debug");

      log.level = originalLogLevel; //restore since log is a singleton
    });

    it("should use silent for the log level if no logLevel is specified", function() {
      var originalLogLevel = log.level;

      log.level = "foo;";

      var client = new Client();
      client.logLevel.should.equal("silent");
      log.level.should.equal("silent");

      log.level = originalLogLevel; //restore since log is a singleton
    });
  });

  describe("Client Internals", function() {
    it("should expose bitcore", function() {
      should.exist(Client.Bitcore);
      should.exist(Client.Bitcore.HDPublicKey);
    });
  });

  describe("Server internals", function() {
    it("should allow cors", function(done) {
      clients[0].device = {};
      clients[0].copayer = {};
      clients[0]._doRequest("options", "/", {}, false, function(err, x, headers) {
        headers["access-control-allow-origin"].should.equal("*");
        should.exist(headers["access-control-allow-methods"]);
        should.exist(headers["access-control-allow-headers"]);
        done();
      });
    });

    it("should handle critical errors", function(done) {
      var s = sinon.stub();
      s.storeWallet = sinon.stub().yields("bigerror");
      s.fetchWallet = sinon.stub().yields(null);
      var expressApp = new ExpressApp();
      expressApp.start(
        {
          storage: s,
          blockchainExplorer: blockchainExplorerMock,
          disableLogs: true
        },
        function() {
          var s2 = sinon.stub();
          s2.load = sinon.stub().yields(null);
          var client = helpers.newClient(app);
          client.storage = s2;
          client.createWallet("1", "2", 1, 1, {network: "livenet"}, function(err) {
            err.should.be.an.instanceOf(Error);
            err.message.should.equal("bigerror");
            done();
          });
        }
      );
    });

    it("should handle critical errors (Case2)", function(done) {
      var s = sinon.stub();
      s.storeWallet = sinon.stub().yields({
        code: 501,
        message: "wow"
      });
      s.fetchWallet = sinon.stub().yields(null);
      var expressApp = new ExpressApp();
      expressApp.start(
        {
          storage: s,
          blockchainExplorer: blockchainExplorerMock,
          disableLogs: true
        },
        function() {
          var s2 = sinon.stub();
          s2.load = sinon.stub().yields(null);
          var client = helpers.newClient(app);
          client.storage = s2;
          client.createWallet("1", "2", 1, 1, {network: "testnet"}, function(err) {
            err.should.be.an.instanceOf(Error);
            err.message.should.equal("wow");
            done();
          });
        }
      );
    });

    it("should handle critical errors (Case3)", function(done) {
      var s = sinon.stub();
      s.storeWallet = sinon.stub().yields({
        code: 404,
        message: "wow"
      });
      s.fetchWallet = sinon.stub().yields(null);
      var expressApp = new ExpressApp();
      expressApp.start(
        {
          storage: s,
          blockchainExplorer: blockchainExplorerMock,
          disableLogs: true
        },
        function() {
          var s2 = sinon.stub();
          s2.load = sinon.stub().yields(null);
          var client = helpers.newClient(app);
          client.storage = s2;
          client.createWallet("1", "2", 1, 1, {network: "testnet"}, function(err) {
            err.should.be.an.instanceOf(Error);
            err.message.should.equal("wow");
            done();
          });
        }
      );
    });

    it("should handle critical errors (Case4)", function(done) {
      var body = {
        code: 999,
        message: "unexpected body"
      };
      var ret = Client._parseError(body);
      ret.should.be.an.instanceOf(Error);
      ret.message.should.equal("999: unexpected body");
      done();
    });

    it("should handle critical errors (Case5)", function(done) {
      clients[0].request = helpers.stubRequest("some error");
      clients[0].createWallet("mywallet", "creator", 1, 2, {network: "testnet"}, function(err, secret) {
        should.exist(err);
        err.should.be.an.instanceOf(Errors.CONNECTION_ERROR);
        done();
      });
    });

    it("should correctly use remote message", function(done) {
      var body = {
        code: "INSUFFICIENT_FUNDS"
      };
      var ret = Client._parseError(body);
      ret.should.be.an.instanceOf(Error);
      ret.message.should.equal("Insufficient funds.");

      var body = {
        code: "INSUFFICIENT_FUNDS",
        message: "remote message"
      };
      var ret = Client._parseError(body);
      ret.should.be.an.instanceOf(Error);
      ret.message.should.equal("remote message");

      var body = {
        code: "MADE_UP_ERROR",
        message: "remote message"
      };
      var ret = Client._parseError(body);
      ret.should.be.an.instanceOf(Error);
      ret.message.should.equal("MADE_UP_ERROR: remote message");
      done();
    });
  });

  describe("Build & sign txs", function() {
    var masterPrivateKey =
      "xprv9s21ZrQH143K2n4rV4AtAJFptEmd1tNMKCcSyQBCSuN5eq1dCUhcv6KQJS49joRxu8NNdFxy8yuwTtzCPNYUZvVGC7EPRm2st2cvE7oyTbB";
    var derivedPrivateKey = {
      BIP44: new Bitcore.HDPrivateKey(masterPrivateKey).deriveChild("m/44'/0'/0'"),
      BIP45: new Bitcore.HDPrivateKey(masterPrivateKey).deriveChild("m/45'"),
      BIP48: new Bitcore.HDPrivateKey(masterPrivateKey).deriveChild("m/48'/0'/0'")
    };

    describe("#buildTx", function() {
      it("should build a tx correctly", function() {
        var address = "4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU";

        var publicKeyRing = [{
          xPubKey: derivedPrivateKey["BIP44"].hdPublicKey
        }];

        helpers.generateUtxos("test-wallet-id", "normal", publicKeyRing, "m/0/0", 1, [2000]);

        var txp = {
          version: 1,
          walletId: "test-wallet-id",
          app: 'payment',
          params: {
            outputs: [{
              address: address,
              amount: 1200
            }]
          },
          derivationStrategy: "BIP44"
        };

        var t = helpers.composeJoint(txp);
        should.exist(t);
      });

      it("should build a tx with multiple outputs", function() {
        var address = "4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU";

        var publicKeyRing = [{
          xPubKey: derivedPrivateKey["BIP44"].hdPublicKey
        }];

        var utxos = helpers.generateUtxos("test-wallet-id", "normal", publicKeyRing, "m/1/0", 1, [2000]);

        var txp = {
          version: 1,
          walletId: "test-wallet-id",
          app: 'payment',
          params: {
            outputs: [
              {
                address: address,
                amount: 1200
              },
              {
                address: address,
                amount: 600
              }
            ]
          },
          derivationStrategy: "BIP44"
        };

        var t = helpers.composeJoint(txp);
        should.exist(t);
      });
    });

    describe("#signTxp", function() {
      it("should sign BIP45 correctly", function() {
        var address = "4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU";

        var publicKeyRing = [{
          xPubKey: derivedPrivateKey["BIP45"].hdPublicKey
        }];

        var utxos = helpers.generateUtxos("test-wallet-id", "normal", publicKeyRing, "m/2147483647/0/0", 1, [2000]);
        
        var txp = {
          version: 1,
          walletId: "test-wallet-id",
          app: 'payment',
          params: {
            outputs: [{
              address: address,
              amount: 1200
            }]
          },
          derivationStrategy: "BIP45"
        };
        var t = helpers.composeJoint(txp);
        var signatures = Client.signTxp(t, derivedPrivateKey["BIP45"], "test-wallet-id");
        should.exist(signatures);
      });

      it("should sign BIP44 correctly", function() {
        var address = "4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU";

        var publicKeyRing = [{
          xPubKey: derivedPrivateKey["BIP44"].hdPublicKey
        }];

        var utxos = helpers.generateUtxos("test-wallet-id", "normal", publicKeyRing, "m/1/0", 1, [2000]);

        var txp = {
          version: 1,
          walletId: "test-wallet-id",
          app: 'payment',
          params: {
            outputs: [{
              address: address,
              amount: 1200
            }]
          },
          derivationStrategy: "BIP44"
        };
        var t = helpers.composeJoint(txp);
        var signatures = Client.signTxp(t, derivedPrivateKey["BIP44"], "test-wallet-id");
        should.exist(signatures);
      });

      it("should sign multiple-outputs proposal correctly", function() {
        var address = "4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU";

        var publicKeyRing = [{
          xPubKey: derivedPrivateKey["BIP44"].hdPublicKey
        }];

        var utxos = helpers.generateUtxos("test-wallet-id", "normal", publicKeyRing, "m/1/0", 1, [2000]);

        var txp = {
          version: 1,
          walletId: "test-wallet-id",
          app: 'payment',
          params: {
            outputs: [
                {
                address: address,
                amount: 1200
              },
              {
                address: address,
                amount: 600
              }
            ],
          },
          derivationStrategy: "BIP44"
        };

        var t = helpers.composeJoint(txp);
        var signatures = Client.signTxp(t, derivedPrivateKey["BIP44"], "test-wallet-id");
        should.exist(signatures);
      });
    });
  });

  describe("Wallet secret round trip", function() {
    it("should create secret and parse secret", function() {
      var i = 0;
      while (i++ < 100) {
        var walletId = Uuid.v4();
        var walletPrivKey = new Bitcore.PrivateKey();
        var network = i % 2 == 0 ? "testnet" : "livenet";
        var coin = "obyte";
        var secret = Client._buildSecret(walletId, walletPrivKey, coin, network);
        var result = Client.parseSecret(secret);
        result.walletId.should.equal(walletId);
        result.walletPrivKey.toString().should.equal(walletPrivKey.toString());
        result.coin.should.equal(coin);
        result.network.should.equal(network);
      }
    });

    it("should fail on invalid secret", function() {
      (function() {
        Client.parseSecret("invalidSecret");
      }.should.throw("Invalid secret"));
    });

    it("should create secret and parse secret from string", function() {
      var walletId = Uuid.v4();
      var walletPrivKey = new Bitcore.PrivateKey();
      var coin = "obyte";
      var network = "testnet";
      var secret = Client._buildSecret(walletId, walletPrivKey.toString(), coin, network);
      var result = Client.parseSecret(secret);
      result.walletId.should.equal(walletId);
      result.walletPrivKey.toString().should.equal(walletPrivKey.toString());
      result.coin.should.equal(coin);
      result.network.should.equal(network);
    });

    it("should default to obyte for secrets not specifying coin", function() {
      var result = Client.parseSecret(
        "8RJ4Wa5PhCtXLaHespTr4aKwJuRYKwdssp2mEqRWysvp7FJe7HYMDyridaY4Li4NdchDTXk2pDTobyte"
      );
      result.coin.should.equal("obyte");
    });
  });

  describe("Notification polling", function() {
    var clock, interval;

    beforeEach(function() {
      clock = sinon.useFakeTimers({ now: 1234000, toFake: ["Date"] });
    });

    afterEach(function() {
      clock.restore();
    });

    it("should fetch notifications at intervals", function(done) {
      helpers.createAndJoinWallet(clients, 2, 2, function(res) {
        clients[0].on("notification", function(data) {
          notifications.push(data);
        });

        var notifications = [];
        clients[0]._fetchLatestNotifications(5, function() {
          _.map(notifications, "type").should.deep.equal([
            "NewCopayer",
            "WalletComplete"
          ]);
          clock.tick(2000);
          notifications = [];
          clients[0]._fetchLatestNotifications(5, function() {
            notifications.length.should.equal(0);
            clock.tick(2000);
            clients[1].createAddress(function(err, x) {
              should.not.exist(err);
              clients[0]._fetchLatestNotifications(5, function() {
                _.map(notifications, "type").should.deep.equal(["NewAddress"]);
                clock.tick(2000);
                notifications = [];
                clients[0]._fetchLatestNotifications(5, function() {
                  notifications.length.should.equal(0);
                  clients[1].createAddress(function(err, x) {
                    should.not.exist(err);
                    clock.tick(60 * 1000);
                    clients[0]._fetchLatestNotifications(5, function() {
                      notifications.length.should.equal(0);
                      done();
                    });
                  });
                });
              });
            });
          });
        });
      });
    });
  });

  describe("Wallet Creation", function() {
    beforeEach(done => {
      db.dropDatabase(function(err) {
        return done(err);
      });
    });

    it("should fail to create wallet in bogus device", function(done) {
      clients[0].seedFromRandomWithMnemonic();
      clients[0].keyDerivationOk = false;
      clients[0].createWallet("mywallet", "pepe", 1, 1, {}, function(err, secret) {
        should.exist(err);
        should.not.exist(secret);
        done();
      });
    });

    it("should encrypt wallet name", function(done) {
      var spy = sinon.spy(clients[0], "_doPostRequest");
      clients[0].seedFromRandomWithMnemonic();
      clients[0].createWallet("mywallet", "pepe", 1, 1, {}, function(err, secret) {
        should.not.exist(err);
        var url = spy.getCall(0).args[0];
        var body = JSON.stringify(spy.getCall(0).args[1]);
        url.should.contain("/wallets");
        body.should.not.contain("mywallet");
        clients[0].getStatus({}, function(err, status) {
          should.not.exist(err);
          status.wallet.name.should.equal("mywallet");
          done();
        });
      });
    });

    it("should encrypt copayer name in wallet creation", function(done) {
      var spy = sinon.spy(clients[0], "_doPostRequest");
      clients[0].seedFromRandomWithMnemonic();
      clients[0].createWallet("mywallet", "pepe", 1, 1, {}, function(err, secret) {
        should.not.exist(err);
        var url = spy.getCall(1).args[0];
        var body = JSON.stringify(spy.getCall(1).args[1]);
        url.should.contain("/copayers");
        body.should.not.contain("pepe");
        clients[0].getStatus({}, function(err, status) {
          should.not.exist(err);
          status.wallet.copayers[0].name.should.equal("pepe");
          done();
        });
      });
    });

    it("should be able to access wallet name in non-encrypted wallet", function(done) {
      clients[0].seedFromRandomWithMnemonic();
      var wpk = new Bitcore.PrivateKey();
      var args = {
        name: "mywallet",
        m: 1,
        n: 1,
        pubKey: wpk.toPublicKey().toString(),
        network: "livenet",
        id: "123"
      };
      clients[0]._doPostRequest("/v1/wallets/", args, function(err, wallet) {
        should.not.exist(err);
        var d = clients[0].device;
        var c = clients[0].copayer;

        var args = {
          walletId: "123",
          name: "pepe",
          xPubKey: c.xPubKey,
          requestPubKey: d.requestPubKey,
          deviceId: d.deviceId,
          account: c.account,
          customData: Utils.encryptMessage(
            JSON.stringify({
              walletPrivKey: wpk.toString()
            }),
            d.personalEncryptingKey
          )
        };
        var hash = Utils.getCopayerHash(
          args.name,
          args.xPubKey,
          args.requestPubKey
        );
        args.copayerSignature = Utils.signMessage(hash, wpk);
        clients[0]._doPostRequest("/v1/wallets/123/copayers", args, function(err, wallet) {
          should.not.exist(err);
          clients[0].openWallet(function(err) {
            should.not.exist(err);
            clients[0].getStatus({}, function(err, status) {
              should.not.exist(err);
              var wallet = status.wallet;
              wallet.name.should.equal("mywallet");
              should.not.exist(wallet.encryptedName);
              wallet.copayers[0].name.should.equal("pepe");
              should.not.exist(wallet.copayers[0].encryptedName);
              done();
            });
          });
        });
      });
    });

    it("should check balance in a 1-1 ", function(done) {
      helpers.createAndJoinWallet(clients, 1, 1, function() {
        clients[0].getBalance({}, function(err, balance) {
          should.not.exist(err);
          balance.base.stable.should.equal(0);
          balance.base.pending.should.equal(0);
          done();
        });
      });
    });

    it("should be able to complete wallet in copayer that joined later", function(done) {
      helpers.createAndJoinWallet(clients, 2, 3, function() {
        clients[0].getBalance({}, function(err, x) {
          should.not.exist(err);
          clients[1].getBalance({}, function(err, x) {
            should.not.exist(err);
            clients[2].getBalance({}, function(err, x) {
              should.not.exist(err);
              done();
            });
          });
        });
      });
    });

    it("should fire event when wallet is complete", function(done) {
      var checks = 0;
      clients[0].on("walletCompleted", function(wallet) {
        wallet.name.should.equal("mywallet");
        wallet.status.should.equal("complete");
        clients[0].isComplete().should.equal(true);
        clients[0].copayer.isComplete().should.equal(true);
        if (++checks == 2) done();
      });
      clients[0].createWallet("mywallet", "creator", 2, 2, {network: "livenet"}, 
        function(err, secret) {
          should.not.exist(err);
          clients[0].isComplete().should.equal(false);
          clients[0].copayer.isComplete().should.equal(false);
          clients[1].joinWallet(secret, "guest", {}, function(err, wallet) {
            should.not.exist(err);
            wallet.name.should.equal("mywallet");
            clients[0].openWallet(function(err, walletStatus) {
              should.not.exist(err);
              should.exist(walletStatus);
              _.difference(_.map(walletStatus.copayers, "name"), [
                "creator",
                "guest"
              ]).length.should.equal(0);
              if (++checks == 2) done();
            });
          });
        }
      );
    });

    it("should fill wallet info in an incomplete wallet", function(done) {
      clients[0].seedFromRandomWithMnemonic();
      clients[0].createWallet("XXX", "creator", 2, 3, {}, function(err, secret) {
        should.not.exist(err);
        clients[1].seedFromMnemonic(clients[0].getMnemonic());
        clients[1].openWallet(function(err) {
          clients[1].copayer.walletName.should.equal("XXX");
          clients[1].copayer.m.should.equal(2);
          clients[1].copayer.n.should.equal(3);
          should.not.exist(err);
          done();
        });
      });
    });

    it("should return wallet on successful join", function(done) {
      clients[0].createWallet("mywallet", "creator", 2, 2, {network: "livenet"},
        function(err, secret) {
          should.not.exist(err);
          clients[1].joinWallet(secret, "guest", {}, function(err, wallet) {
            should.not.exist(err);
            wallet.name.should.equal("mywallet");
            wallet.copayers[0].name.should.equal("creator");
            wallet.copayers[1].name.should.equal("guest");
            done();
          });
        }
      );
    });

    it("should not allow to join wallet on bogus device", function(done) {
      clients[0].createWallet("mywallet", "creator", 2, 2, {network: "testnet"},
        function(err, secret) {
          should.not.exist(err);
          clients[1].keyDerivationOk = false;
          clients[1].joinWallet(secret, "guest", {}, function(err, wallet) {
            should.exist(err);
            done();
          });
        }
      );
    });

    it("should not allow to join a full wallet ", function(done) {
      helpers.createAndJoinWallet(clients, 2, 2, function(w) {
        should.exist(w.secret);
        clients[4].joinWallet(w.secret, "copayer", {}, function(err, result) {
          err.should.be.an.instanceOf(Errors.WALLET_FULL);
          done();
        });
      });
    });

    it("should fail with an invalid secret", function(done) {
      // Invalid
      clients[0].joinWallet("dummy", "copayer", {}, function(err, result) {
        err.message.should.contain("Invalid secret");
        // Right length, invalid char for base 58
        clients[0].joinWallet(
          "DsZbqNQQ9LrTKU8EknR7gFKyCQMPg2UUHNPZ1BzM5EbJwjRZaUNBfNtdWLluuFc0f7f7sTCkh7T",
          "copayer",
          {},
          function(err, result) {
            err.message.should.contain("Invalid secret");
            done();
          }
        );
      });
    });

    it("should fail with an unknown secret", function(done) {
      // Unknown walletId
      var oldSecret =
        "3bJKRn1HkQTpwhVaJMaJ22KwsjN24ML9uKfkSrP7iDuq91vSsTEygfGMMpo6kWLp1pXG9wZSKcT";
      clients[0].joinWallet(oldSecret, "copayer", {}, function(err, result) {
        err.should.be.an.instanceOf(Errors.WALLET_NOT_FOUND);
        done();
      });
    });

    it("should detect wallets with bad signatures", function(done) {
      // Do not complete clients[1] pkr
      var openWalletStub = sinon.stub(clients[1], "openWallet").yields();

      helpers.createAndJoinWallet(clients, 2, 3, function() {
        helpers.tamperResponse([clients[0], clients[1]], "get", "/v1/wallets/", {},
          function(status) {
            status.wallet.copayers[0].xPubKey =
              status.wallet.copayers[1].xPubKey;
          },
          function() {
            openWalletStub.restore();
            clients[1].openWallet(function(err, x) {
              err.should.be.an.instanceOf(Errors.SERVER_COMPROMISED);
              done();
            });
          }
        );
      });
    });

    it("should detect wallets with missing signatures", function(done) {
      // Do not complete clients[1] pkr
      var openWalletStub = sinon.stub(clients[1], "openWallet").yields();

      helpers.createAndJoinWallet(clients, 2, 3, function() {
        helpers.tamperResponse([clients[0], clients[1]], "get", "/v1/wallets/", {},
          function(status) {
            delete status.wallet.copayers[1].xPubKey;
          },
          function() {
            openWalletStub.restore();
            clients[1].openWallet(function(err, x) {
              err.should.be.an.instanceOf(Errors.SERVER_COMPROMISED);
              done();
            });
          }
        );
      });
    });

    it("should detect wallets missing callers pubkey", function(done) {
      // Do not complete clients[1] pkr
      var openWalletStub = sinon.stub(clients[1], "openWallet").yields();

      helpers.createAndJoinWallet(clients, 2, 3, function() {
        helpers.tamperResponse([clients[0], clients[1]], "get", "/v1/wallets/", {},
          function(status) {
            // Replace caller's pubkey
            status.wallet.copayers[1].xPubKey = new Bitcore.HDPrivateKey().publicKey;
            // Add a correct signature
            status.wallet.copayers[1].xPubKeySignature = Utils.signMessage(
              status.wallet.copayers[1].xPubKey.toString(),
              clients[0].device.walletPrivKey
            );
          },
          function() {
            openWalletStub.restore();
            clients[1].openWallet(function(err, x) {
              err.should.be.an.instanceOf(Errors.SERVER_COMPROMISED);
              done();
            });
          }
        );
      });
    });

    it("should perform a dry join without actually joining", function(done) {
      clients[0].createWallet("mywallet", "creator", 1, 2, {}, function(err, secret) {
        should.not.exist(err);
        should.exist(secret);
        clients[1].joinWallet(secret, "dummy", {dryRun: true},
          function(err, wallet) {
            should.not.exist(err);
            should.exist(wallet);
            wallet.status.should.equal("pending");
            wallet.copayers.length.should.equal(1);
            done();
          }
        );
      });
    });

    it("should return wallet status even if wallet is not yet complete", function(done) {
      clients[0].createWallet("mywallet", "creator", 1, 2, {network: "testnet"},
        function(err, secret) {
          should.not.exist(err);
          should.exist(secret);

          clients[0].getStatus({}, function(err, status) {
            should.not.exist(err);
            should.exist(status);
            status.wallet.status.should.equal("pending");
            should.exist(status.wallet.secret);
            status.wallet.secret.should.equal(secret);
            done();
          });
        }
      );
    });

    it("should return status", function(done) {
      clients[0].createWallet("mywallet", "creator", 1, 1, {network: "testnet"},
        function(err, secret) {
          should.not.exist(err);
          clients[0].getStatus({}, function(err, status) {
            should.not.exist(err);
            should.not.exist(status.wallet.publicKeyRing);
            status.wallet.status.should.equal("complete");
            done();
          });
        }
      );
    });

    it("should return extended status", function(done) {
      clients[0].createWallet("mywallet", "creator", 1, 1, {network: "testnet"},
        function(err, secret) {
          should.not.exist(err);
          clients[0].getStatus({includeExtendedInfo: true},
            function(err, status) {
              should.not.exist(err);
              status.wallet.publicKeyRing.length.should.equal(1);
              status.wallet.status.should.equal("complete");
              done();
            }
          );
        }
      );
    });

    it("should store walletPrivKey", function(done) {
      clients[0].createWallet("mywallet", "creator", 1, 1, {network: "testnet"},
        function(err) {
          var key = clients[0].copayer.walletPrivKey;
          should.not.exist(err);
          clients[0].getStatus({includeExtendedInfo: true},
            function(err, status) {
              should.not.exist(err);
              status.wallet.publicKeyRing.length.should.equal(1);
              status.wallet.status.should.equal("complete");
              var key2 = status.customData.walletPrivKey;

              clients[0].copayer.walletPrivKey.should.be.equal(key2);
              done();
            }
          );
        }
      );
    });

    it("should set walletPrivKey from OWS", function(done) {
      clients[0].createWallet("mywallet", "creator", 1, 1, {network: "testnet"},
        function(err) {
          var wkey = clients[0].copayer.walletPrivKey;
          var skey = clients[0].copayer.sharedEncryptingKey;
          delete clients[0].copayer.walletPrivKey;
          delete clients[0].copayer.sharedEncryptingKey;
          should.not.exist(err);
          clients[0].getStatus({includeExtendedInfo: true},
            function(err, status) {
              should.not.exist(err);
              clients[0].copayer.walletPrivKey.should.equal(wkey);
              clients[0].copayer.sharedEncryptingKey.should.equal(skey);
              done();
            }
          );
        }
      );
    });

    it("should create a 1-1 wallet with random mnemonic", function(done) {
      clients[0].seedFromRandomWithMnemonic();
      clients[0].createWallet("mywallet", "creator", 1, 1, {network: "livenet"},
        function(err) {
          should.not.exist(err);
          clients[0].openWallet(function(err) {
            should.not.exist(err);
            should.not.exist(err);
            clients[0].device.network.should.equal("livenet");
            clients[0].getMnemonic().split(" ").length.should.equal(12);
            done();
          });
        }
      );
    });

    it("should create a 1-1 wallet with given mnemonic", function(done) {
      var words =
        "forget announce travel fury farm alpha chaos choice talent sting eagle supreme";
      clients[0].seedFromMnemonic(words);
      clients[0].createWallet("mywallet", "creator", 1, 1,
        {
          network: "livenet",
          derivationStrategy: "BIP48"
        },
        function(err) {
          should.not.exist(err);
          clients[0].openWallet(function(err) {
            should.not.exist(err);
            should.exist(clients[0].getMnemonic());
            words.should.be.equal(clients[0].getMnemonic());
            clients[0].device.xPrivKey.should.equal(
              "xprv9s21ZrQH143K4X2frJxRmGsmef9UfXhmfL4hdTGLm5ruSX46gekuSTspJX63d5nEi9q2wqUgg4KZ4yhSPy13CzVezAH6t6gCox1DN2hXV3L"
            );
            done();
          });
        }
      );
    });

    it("should create a 2-3 wallet with given mnemonic", function(done) {
      var words =
        "forget announce travel fury farm alpha chaos choice talent sting eagle supreme";
      clients[0].seedFromMnemonic(words);
      clients[0].createWallet("mywallet", "creator", 2, 3, {network: "livenet"},
        function(err, secret) {
          should.not.exist(err);
          should.exist(secret);
          clients[0].openWallet(function(err) {
            should.not.exist(err);
            should.exist(clients[0].getMnemonic());
            words.should.be.equal(clients[0].getMnemonic());
            clients[0].device.xPrivKey.should.equal(
              "xprv9s21ZrQH143K4X2frJxRmGsmef9UfXhmfL4hdTGLm5ruSX46gekuSTspJX63d5nEi9q2wqUgg4KZ4yhSPy13CzVezAH6t6gCox1DN2hXV3L"
            );
            done();
          });
        }
      );
    });
  });

  describe("#getMainAddresses", function() {
    beforeEach(function(done) {
      helpers.createAndJoinWallet(clients, 1, 1, function(w) {
        clients[0].createAddress(function(err, x0) {
          should.not.exist(err);
          clients[0].createAddress(function(err, x0) {
            should.not.exist(err);
            blockchainExplorerMock.setUtxo(x0, 1e9);
            done();
          });
        });
      });
    });

    it("Should return all main addresses", function(done) {
      clients[0].getMainAddresses( { doNotVerify: true },
        function(err, addr) {
          should.not.exist(err);
          addr.length.should.equal(2);
          done();
        }
      );
    });

    it("Should return only main addresses when change addresses exist", function(done) {
      var opts = {
        app: 'payment',
        params: {
          outputs: [{
            amount: 0.1e8,
            address: "4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU",
          }]
        },
        message: "hello 1-1"
      };
      helpers.createAndPublishTxProposal(clients[0], opts, function(err, x) {
        should.not.exist(err);
        clients[0].getMainAddresses({}, function(err, addr) {
          should.not.exist(err);
          addr.length.should.equal(2);
          done();
        });
      });
    });
  });

  describe("#getUtxos", function() {
    beforeEach(function(done) {
      helpers.createAndJoinWallet(clients, 1, 1, function(w) {
        done();
      });
    });

    it("Should return UTXOs", function(done) {
      clients[0].getUtxos({}, function(err, utxos) {
        should.not.exist(err);
        utxos.length.should.equal(0);
        clients[0].createAddress(function(err, x0) {
          should.not.exist(err);
          should.exist(x0.address);
          blockchainExplorerMock.setUtxo(x0, 1e9);
          clients[0].getUtxos({}, function(err, utxos) {
            should.not.exist(err);
            utxos.length.should.equal(1);
            done();
          });
        });
      });
    });

    it("Should return UTXOs for specific addresses", function(done) {
      async.map(
        _.range(3),
        function(i, next) {
          clients[0].createAddress(function(err, x) {
            should.not.exist(err);
            should.exist(x.address);
            blockchainExplorerMock.setUtxo(x, 1e9);
            next(null, x.address);
          });
        },
        function(err, addresses) {
          var opts = {
            addresses: _.take(addresses, 2)
          };
          clients[0].getUtxos(opts, function(err, utxos) {
            should.not.exist(err);
            utxos.length.should.equal(2);
            _.sumBy(utxos, "amount").should.equal(2 * 1e9);
            done();
          });
        }
      );
    });
  });

  describe("Version", function() {
    it("should get version of ows", function(done) {
      clients[0].credentials = {};
      clients[0].getVersion(function(err, version) {
        if (err) {
          // if ows is older version without getVersion support
          err.should.be.an.instanceOf(Errors.NOT_FOUND);
        } else {
          // if ows is up-to-date
          should.exist(version);
          should.exist(version.serviceVersion);
          version.serviceVersion.should.contain("ows-");
        }
        done();
      });
    });
  });

  describe("Preferences", function() {
    it("should save and retrieve preferences", function(done) {
      helpers.createAndJoinWallet(clients, 1, 1, function() {
        clients[0].getPreferences(function(err, preferences) {
          should.not.exist(err);
          preferences.should.be.empty;
          clients[0].savePreferences( { email: "dummy@dummy.com" },
            function(err) {
              should.not.exist(err);
              clients[0].getPreferences(function(err, preferences) {
                should.not.exist(err);
                should.exist(preferences);
                preferences.email.should.equal("dummy@dummy.com");
                done();
              });
            }
          );
        });
      });
    });
  });

  describe("Fiat rates", function() {
    it("should get fiat exchange rate", function(done) {
      var now = Date.now();
      helpers.createAndJoinWallet(clients, 1, 1, function() {
        clients[0].getFiatRate(
          {
            code: "USDT-GBYTE",
            ts: now
          },
          function(err, res) {
            should.not.exist(err);
            should.exist(res);
            res.ts.should.equal(now);
            should.not.exist(res.rate);
            done();
          }
        );
      });
    });
  });

  describe("Push notifications", function() {
    it("should do a post request", function(done) {
      helpers.createAndJoinWallet(clients, 1, 1, function() {
        clients[0]._doRequest = sinon.stub().yields(null, {
          statusCode: 200
        });
        clients[0].pushNotificationsSubscribe(function(err, res) {
          should.not.exist(err);
          should.exist(res);
          res.statusCode.should.be.equal(200);
          done();
        });
      });
    });

    it("should do a delete request", function(done) {
      helpers.createAndJoinWallet(clients, 1, 1, function() {
        clients[0]._doRequest = sinon.stub().yields(null);
        clients[0].pushNotificationsUnsubscribe("123", function(err) {
          should.not.exist(err);
          done();
        });
      });
    });
  });

  describe("Tx confirmations", function() {
    it("should do a post request", function(done) {
      helpers.createAndJoinWallet(clients, 1, 1, function() {
        clients[0]._doRequest = sinon.stub().yields(null, {
          statusCode: 200
        });
        clients[0].txConfirmationSubscribe( { txid: "123" },
          function(err, res) {
            should.not.exist(err);
            should.exist(res);
            res.statusCode.should.be.equal(200);
            done();
          }
        );
      });
    });

    it("should do a delete request", function(done) {
      helpers.createAndJoinWallet(clients, 1, 1, function() {
        clients[0]._doRequest = sinon.stub().yields(null);
        clients[0].txConfirmationUnsubscribe("123", function(err) {
          should.not.exist(err);
          done();
        });
      });
    });
  });

  describe("Address Creation", function() {
    it("should be able to create address in 1-of-1 wallet", function(done) {
      helpers.createAndJoinWallet(clients, 1, 1, function() {
        clients[0].createAddress(function(err, x) {
          should.not.exist(err);
          should.exist(x.address);
          done();
        });
      });
    });

    it("should fail if key derivation is not ok", function(done) {
      helpers.createAndJoinWallet(clients, 1, 1, function() {
        clients[0].keyDerivationOk = false;
        clients[0].createAddress(function(err, address) {
          should.exist(err);
          should.not.exist(address);
          err.message.should.contain("new address");
          done();
        });
      });
    });

    it("should be able to create address in all copayers in a 2-3 wallet", function(done) {
      this.timeout(5000);
      helpers.createAndJoinWallet(clients, 2, 3, function() {
        clients[0].createAddress(function(err, x) {
          should.not.exist(err);
          should.exist(x.address);
          clients[1].createAddress(function(err, x) {
            should.not.exist(err);
            should.exist(x.address);
            clients[2].createAddress(function(err, x) {
              should.not.exist(err);
              should.exist(x.address);
              done();
            });
          });
        });
      });
    });

    it("should see balance on address created by others", function(done) {
      this.timeout(5000);
      helpers.createAndJoinWallet(clients, 2, 2, function(w) {
        clients[0].createAddress(function(err, x0) {
          should.not.exist(err);
          should.exist(x0.address);

          blockchainExplorerMock.setUtxo(x0, 1e9);
          clients[0].getBalance({}, function(err, bal0) {
            should.not.exist(err);
            bal0.base.stable.should.equal(1e9);
            bal0.base.pending.should.equal(0);
            clients[1].getBalance({}, function(err, bal1) {
              bal1.base.stable.should.equal(1e9);
              bal1.base.pending.should.equal(0);
              done();
            });
          });
        });
      });
    });

    it("should detect fake addresses", function(done) {
      helpers.createAndJoinWallet(clients, 1, 1, function() {
        helpers.tamperResponse(
          clients[0],
          "post",
          "/v1/addresses/",
          {},
          function(address) {
            address.address = "4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU";
          },
          function() {
            clients[0].createAddress(function(err, x0) {
              err.should.be.an.instanceOf(Errors.SERVER_COMPROMISED);
              done();
            });
          }
        );
      });
    });

    it("should be able to derive 25 addresses", function(done) {
      this.timeout(5000);
      var num = 25;
      helpers.createAndJoinWallet(clients, 1, 1, function() {
        function create(callback) {
          clients[0].createAddress( { ignoreMaxGap: true },
            function(err, x) {
              should.not.exist(err);
              should.exist(x.address);
              callback(err, x);
            }
          );
        }

        var tasks = [];
        for (var i = 0; i < num; i++) {
          tasks.push(create);
        }

        async.parallel(tasks, function(err, results) {
          should.not.exist(err);
          results.length.should.equal(num);
          done();
        });
      });
    });
  });

  describe("Notifications", function() {
    var clock;
    beforeEach(function(done) {
      this.timeout(5000);
      clock = sinon.useFakeTimers({ now: 1234000, toFake: ["Date"] });
      helpers.createAndJoinWallet(clients, 2, 2, function() {
        clock.tick(25 * 1000);
        clients[0].createAddress(function(err, x) {
          should.not.exist(err);
          clock.tick(25 * 1000);
          clients[1].createAddress(function(err, x) {
            should.not.exist(err);
            done();
          });
        });
      });
    });
    afterEach(function() {
      clock.restore();
    });

    it("should receive notifications", function(done) {
      clients[0].getNotifications({}, function(err, notifications) {
        should.not.exist(err);
        notifications.length.should.equal(3);
        _.map(notifications, "type").should.deep.equal([
          "NewCopayer",
          "WalletComplete",
          "NewAddress"
        ]);
        clients[0].getNotifications(
          {
            lastNotificationId: _.last(notifications).id
          },
          function(err, notifications) {
            should.not.exist(err);
            notifications.length.should.equal(
              0,
              "should only return unread notifications"
            );
            done();
          }
        );
      });
    });

    it("should not receive old notifications", function(done) {
      clock.tick(61 * 1000); // more than 60 seconds
      clients[0].getNotifications({}, function(err, notifications) {
        should.not.exist(err);
        notifications.length.should.equal(0);
        done();
      });
    });

    it("should not receive notifications for self generated events unless specified", function(done) {
      clients[0].getNotifications({}, function(err, notifications) {
        should.not.exist(err);
        notifications.length.should.equal(3);
        _.map(notifications, "type").should.deep.equal([
          "NewCopayer",
          "WalletComplete",
          "NewAddress"
        ]);
        clients[0].getNotifications(
          {
            includeOwn: true
          },
          function(err, notifications) {
            should.not.exist(err);
            notifications.length.should.equal(5);
            _.map(notifications, "type").should.deep.equal([
              "NewCopayer",
              "NewCopayer",
              "WalletComplete",
              "NewAddress",
              "NewAddress"
            ]);
            done();
          }
        );
      });
    });
  });

  describe("Transaction Proposals Creation and Locked funds", function() {
    var myAddress;
    beforeEach(function(done) {
      db.dropDatabase(function(err) {
        helpers.createAndJoinWallet(clients, 2, 3, {}, function(w) {
          clients[0].createAddress(function(err, address) {
            should.not.exist(err);
            myAddress = address;
            blockchainExplorerMock.setUtxo(address, 2e9);
            blockchainExplorerMock.setUtxo(address, 2e9);
            blockchainExplorerMock.setUtxo(address, 2e9);
            blockchainExplorerMock.setUtxo(address, 2e9);
            blockchainExplorerMock.setUtxo(address, 2e9);
            blockchainExplorerMock.setUtxo(address, 2e9);
            blockchainExplorerMock.setUtxo(address, 2e9);
            done(err);
          });
        });
      });
    });

    it("Should create & publish proposal", function(done) {
      var address = "4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU";
      var opts = {
        app: 'payment',
        params: {
          outputs: [
            {
              amount: 1e9,
              address: address,
            },
            {
              amount: 1e9,
              address: address
            }
          ]
        },
        message: "hello",
        customData: {
          someObj: {
            x: 1
          },
          someStr: "str"
        }
      };

      opts = helpers.composeJoint(opts);
      clients[0].createTxProposal(opts, function(err, txp) {
        should.not.exist(err);
        should.exist(txp);

        txp.status.should.equal("temporary");
        txp.message.should.equal("hello");

        should.exist(txp.encryptedMessage);

        clients[0].getPendingTxProposals({}, function(err, txps) {
          should.not.exist(err);
          txps.should.be.empty;

          clients[0].publishTxProposal({txp: txp}, function(err, publishedTxp) {
            should.not.exist(err);
            should.exist(publishedTxp);
            publishedTxp.status.should.equal("pending");
            clients[0].getTxProposals({}, function(err, txps) {
              should.not.exist(err);
              txps.length.should.equal(1);
              var x = txps[0];
              x.id.should.equal(txp.id);
              should.exist(x.proposalSignature);
              should.not.exist(x.proposalSignaturePubKey);
              should.not.exist(x.proposalSignaturePubKeySig);
              // Should be visible for other copayers as well
              clients[1].getTxProposals({}, function(err, txps) {
                should.not.exist(err);
                txps.length.should.equal(1);
                txps[0].id.should.equal(txp.id);
                done();
              });
            });
          });
        });
      });
    });

    it("Should create, publish, recreate, republish proposal", function(done) {
      var address = "4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU";
      var opts = {
        txProposalId: "1234",
        app: 'payment',
        params: {
          outputs: [
            {
              amount: 1e9,
              address: address,
            },
            {
              amount: 1e9,
              address: address
            }
          ]
        },
        message: "hello",
        customData: {
          someObj: {
            x: 1
          },
          someStr: "str"
        }
      };

      opts = helpers.composeJoint(opts);
      clients[0].createTxProposal(opts, function(err, txp) {
        should.not.exist(err);
        should.exist(txp);
        txp.status.should.equal("temporary");
        clients[0].publishTxProposal({txp: txp}, function(err, publishedTxp) {
          should.not.exist(err);
          should.exist(publishedTxp);
          publishedTxp.status.should.equal("pending");
          clients[0].getTxProposals({}, function(err, txps) {
            should.not.exist(err);
            txps.length.should.equal(1);
            // Try to republish from copayer 1
            clients[1].createTxProposal(opts, function(err, txp) {
              should.not.exist(err);
              should.exist(txp);
              txp.status.should.equal("pending");
              clients[1].publishTxProposal({txp: txp}, function(err, publishedTxp) {
                should.not.exist(err);
                should.exist(publishedTxp);
                publishedTxp.status.should.equal("pending");
                done();
              });
            });
          });
        });
      });
    });

    it("Should protect against tampering at proposal creation", function(done) {
      var opts = {
        app: 'payment',
        params: {
          outputs: [
            {
              amount: 1e9,
              address: "4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU",
            },
            {
              amount: 1e9,
              address: "4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU"
            }
          ],
          change_address: myAddress.address,
        },
        message: "hello"
      };
      opts = helpers.composeJoint(opts);

      var tamperings = [
        function(txp) {
          txp.message = "dummy";
        },
        function(txp) {
          txp.customData = "dummy";
        },
        function(txp) {
          txp.params.outputs.push(txp.params.outputs[0]);
        },
        function(txp) {
          txp.params.outputs[0].address = "6ERVBLCPMRFRZE25SGUL62FVFEDZ5NUH";
        },
        function(txp) {
          txp.params.outputs[0].amount = 2e9;
        },
        function(txp) {
          txp.params.outputs[1].amount = 3e9;
        },
        function(txp) {
          txp.params.change_address = "6ERVBLCPMRFRZE25SGUL62FVFEDZ5NUH";
        }
      ];

      var tmp = clients[0]._getCreateTxProposalArgs;
      var args = clients[0]._getCreateTxProposalArgs(opts);

      clients[0]._getCreateTxProposalArgs = function(opts) {
        return opts;
      };

      async.each( 
        tamperings, 
        function(tamperFn, next) {
          helpers.tamperResponse(clients[0], "post", "/v1/txproposals/", args, tamperFn, function() {
            clients[0].createTxProposal(opts, function(err, txp) {
              should.exist(err, "For tamper function " + tamperFn);
              err.should.be.an.instanceOf(Errors.SERVER_COMPROMISED);
              next();
            });
          });
        },
        function(err) {
          should.not.exist(err);
          clients[0]._getCreateTxProposalArgs = tmp;
          done();
        }
      );
    });

    it("Should fail to publish when not enough available UTXOs", function(done) {
      var opts = {
        app: 'payment',
        params: {
          outputs: [
            {
              amount: 3e8,
              address: "4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU"
            }
          ]
        },
      };
      opts = helpers.composeJoint(opts);

      var txp1, txp2;
      async.series(
        [
          function(next) {
            clients[0].createTxProposal(opts, function(err, txp) {
              txp1 = txp;
              next(err);
            });
          },
          function(next) {
            clients[0].createTxProposal(opts, function(err, txp) {
              txp2 = txp;
              next(err);
            });
          },
          function(next) {
            clients[0].publishTxProposal({ txp: txp1 }, next);
          },
          function(next) {
            clients[0].publishTxProposal( { txp: txp2 },
              function(err) {
                should.exist(err);
                err.should.be.an.instanceOf(Errors.UNAVAILABLE_UTXOS);
                next();
              }
            );
          },
          function(next) {
            clients[1].rejectTxProposal(txp1, "Free locked UTXOs", next);
          },
          function(next) {
            clients[2].rejectTxProposal(txp1, "Free locked UTXOs", next);
          },
          function(next) {
            delete blockchainExplorerMock.utxos[0].locked;
            clients[0].publishTxProposal( { txp: txp2 }, next );
          }
        ],
        function(err) {
          should.not.exist(err);
          done();
        }
      );
    });

    it("Should create proposal with unconfirmed inputs", function(done) {
      var opts = {
        app: 'payment',
        params: {
          outputs: [{
            amount: 4.5e8,
            address: "4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU",
          }]
        },
        message: "hello"
      };
      helpers.createAndPublishTxProposal(clients[0], opts, function(err, x) {
        should.not.exist(err);
        clients[0].getTx(x.id, function(err, x2) {
          should.not.exist(err);
          done();
        });
      });
    });

    it("Should keep message and refusal texts", function(done) {
      var opts = {
        app: 'payment',
        params: {
          outputs: [{
            amount: 1e8,
            address: "4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU",
          }]
        },
        message: "some message"
      };
      helpers.createAndPublishTxProposal(clients[0], opts, function(err, x) {
        should.not.exist(err);
        clients[1].rejectTxProposal(x, "rejection comment", function(err, tx1) {
          should.not.exist(err);

          clients[2].getTxProposals({}, function(err, txs) {
            should.not.exist(err);
            txs[0].message.should.equal("some message");
            txs[0].actions[0].copayerName.should.equal("copayer 1");
            txs[0].actions[0].comment.should.equal("rejection comment");
            done();
          });
        });
      });
    });

    it("Should hide message and refusal texts if not key is present", function(done) {
      var opts = {
        app: 'payment',
        params: {
          outputs: [{
            amount: 1e8,
            address: "4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU",
          }]
        },
        message: "some message"
      };
      helpers.createAndPublishTxProposal(clients[0], opts, function(err, x) {
        should.not.exist(err);
        clients[1].rejectTxProposal(x, "rejection comment", function(err, tx1) {
          should.not.exist(err);

          clients[2].copayer.sharedEncryptingKey = null;

          clients[2].getTxProposals({}, function(err, txs) {
            should.not.exist(err);
            txs[0].message.should.equal("<ECANNOTDECRYPT>");
            txs[0].actions[0].copayerName.should.equal("<ECANNOTDECRYPT>");
            txs[0].actions[0].comment.should.equal("<ECANNOTDECRYPT>");
            done();
          });
        });
      });
    });

    it("Should encrypt proposal message", function(done) {
      var opts = {
        app: 'payment',
        params: {
          outputs: [{
            amount: 1e8,
            address: "4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU",
          }]
        },
        message: "some message",
      };
      opts = helpers.composeJoint(opts);
      var spy = sinon.spy(clients[0], "_doPostRequest");
      clients[0].createTxProposal(opts, function(err, x) {
        should.not.exist(err);
        spy.calledOnce.should.be.true;
        JSON.stringify(spy.getCall(0).args).should.not.contain("some message");
        done();
      });
    });

    it("Should encrypt proposal refusal comment", function(done) {
      var opts = {
        app: 'payment',
        params: {
          outputs: [{
            amount: 1e8,
            address: "4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU",
          }]
        },
      };
      helpers.createAndPublishTxProposal(clients[0], opts, function(err, x) {
        should.not.exist(err);
        var spy = sinon.spy(clients[1], "_doPostRequest");
        clients[1].rejectTxProposal(x, "rejection comment", function(err, tx1) {
          should.not.exist(err);
          spy.calledOnce.should.be.true;
          JSON.stringify(spy.getCall(0).args).should.not.contain("rejection comment");
          done();
        });
      });
    });
  });

  describe("Transaction Proposal signing", function() {
    this.timeout(5000);
    function setup(m, n, coin, network, cb) {
      helpers.createAndJoinWallet(clients, m, n,
        {
          coin: coin,
          network: network
        },
        function(w) {
          clients[0].createAddress(function(err, address) {
            should.not.exist(err);

            blockchainExplorerMock.setUtxo(address, 2e9);
            blockchainExplorerMock.setUtxo(address, 2e9);
            blockchainExplorerMock.setUtxo(address, 1e9);
            cb();
          });
        }
      );
    }

    beforeEach(function(done) {
      setup(2, 3, "obyte", "livenet", done);
    });

    it("Should sign proposal", function(done) {
      var address = "4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU";
      var opts = {
        app: 'payment',
        params: {
          outputs: [
            {
              amount: 1e8,
              address: address
            },
            {
              amount: 2e8,
              address: address
            }
          ]
        },
        message: "just some message"
      };
      opts = helpers.composeJoint(opts);
      clients[0].createTxProposal(opts, function(err, txp) {
        should.not.exist(err);
        should.exist(txp);
        clients[0].publishTxProposal( { txp: txp },
          function(err, publishedTxp) {
            should.not.exist(err);
            should.exist(publishedTxp);
            publishedTxp.status.should.equal("pending");
            clients[0].signTxProposal(publishedTxp, function(err, txp) {
              should.not.exist(err);
              clients[1].signTxProposal(publishedTxp, function(err, txp) {
                should.not.exist(err);
                txp.status.should.equal("accepted");
                done();
              });
            });
          }
        );
      });
    });
  });

  describe("Proposals with explicit ID", function() {
    it("Should create and publish a proposal", function(done) {
      helpers.createAndJoinWallet(clients, 1, 1, function(w) {
        var id = "anId";
        clients[0].createAddress(function(err, x0) {
          should.not.exist(err);
          should.exist(x0.address);
          blockchainExplorerMock.setUtxo(x0, 1e9);
          var address = "4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU";
          var opts = {
            app: 'payment',
            params: {
              outputs: [{
                amount: 40000,
                address: address
              }]
            },
            txProposalId: id
          };
          opts = helpers.composeJoint(opts);
          clients[0].createTxProposal(opts, function(err, txp) {
            should.not.exist(err);
            should.exist(txp);
            clients[0].publishTxProposal( { txp: txp },
              function(err, publishedTxp) {
                should.not.exist(err);
                publishedTxp.id.should.equal(id);
                clients[0].removeTxProposal(publishedTxp, function(err) {
                  opts.txProposalId = null;
                  clients[0].createTxProposal(opts, function(err, txp) {
                    should.not.exist(err);
                    should.exist(txp);
                    txp.id.should.not.equal(id);
                    done();
                  });
                });
              }
            );
          });
        });
      });
    });
  });

  describe("Transactions Signatures and Rejection", function() {
    this.timeout(5000);
    it("Send and broadcast in 1-1 wallet", function(done) {
      helpers.createAndJoinWallet(clients, 1, 1, function(w) {
        clients[0].createAddress(function(err, x0) {
          should.not.exist(err);
          should.exist(x0.address);
          blockchainExplorerMock.setUtxo(x0, 1e9);
          var opts = {
            app: 'payment',
            params: {
              outputs: [{
                amount: 10000000,
                address: "4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU",
              }]
            },
            message: "hello",
          };
          helpers.createAndPublishTxProposal(clients[0], opts, function(err, txp) {
            should.not.exist(err);
            txp.requiredRejections.should.equal(1);
            txp.requiredSignatures.should.equal(1);
            txp.status.should.equal("pending");
            txp.message.should.equal("hello");
            clients[0].signTxProposal(txp, function(err, txp) {
              should.not.exist(err);
              txp.status.should.equal("accepted");
              txp.message.should.equal("hello");
              clients[0].broadcastTxProposal(txp, function(err, txp) {
                should.not.exist(err);
                txp.status.should.equal("broadcasted");
                txp.message.should.equal("hello");
                done();
              });
            });
          });
        });
      });
    });

    it("should sign if signatures are empty", function(done) {
      helpers.createAndJoinWallet(clients, 1, 1, function(w) {
        clients[0].createAddress(function(err, x0) {
          should.not.exist(err);
          should.exist(x0.address);
          blockchainExplorerMock.setUtxo(x0, 1e9);
          var opts = {
            app: 'payment',
            params: {
              outputs: [{
                amount: 10000000,
                address: "4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU",
              }]
            },
            message: "hello",
          };
          helpers.createAndPublishTxProposal(clients[0], opts, function(err, txp) {
            should.not.exist(err);
            txp.requiredRejections.should.equal(1);
            txp.requiredSignatures.should.equal(1);
            txp.status.should.equal("pending");

            txp.signatures = [];
            clients[0].signTxProposal(txp, function(err, txp) {
              should.not.exist(err);
              txp.status.should.equal("accepted");
              done();
            });
          });
        });
      });
    });

    it("Send and broadcast in 2-3 wallet", function(done) {
      helpers.createAndJoinWallet(clients, 2, 3, function(w) {
        clients[0].createAddress(function(err, x0) {
          should.not.exist(err);
          should.exist(x0.address);
          blockchainExplorerMock.setUtxo(x0, 1e9);
          var opts = {
            app: 'payment',
            params: {
              outputs: [{
                amount: 10000000,
                address: "4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU",
              }]
            },
            message: "hello",
          };
          helpers.createAndPublishTxProposal(clients[0], opts, function(err, txp) {
            should.not.exist(err);
            clients[0].getStatus({}, function(err, st) {
              should.not.exist(err);
              var txp = st.pendingTxps[0];
              txp.status.should.equal("pending");
              txp.requiredRejections.should.equal(2);
              txp.requiredSignatures.should.equal(2);
              var w = st.wallet;
              w.copayers.length.should.equal(3);
              w.status.should.equal("complete");
              clients[0].signTxProposal(txp, function(err, txp) {
                should.not.exist(err, err);
                txp.status.should.equal("pending");
                clients[1].signTxProposal(txp, function(err, txp) {
                  should.not.exist(err);
                  txp.status.should.equal("accepted");
                  clients[1].broadcastTxProposal(txp, function(err, txp) {
                    txp.status.should.equal("broadcasted");
                    done();
                  });
                });
              });
            });
          });
        });
      });
    });

    it.skip("Send, reject actions in 2-3 wallet must have correct copayerNames", function(done) {
      helpers.createAndJoinWallet(clients, 2, 3, function(w) {
        clients[0].createAddress(function(err, x0) {
          should.not.exist(err);
          blockchainExplorerMock.setUtxo(x0, 1e9);
          var opts = {
            app: 'payment',
            params: {
              outputs: [{
                amount: 10000000,
                address: "4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU",
              }]
            },
            message: "hello",
          };
          helpers.createAndPublishTxProposal(clients[0], opts, function(err, txp) {
            should.not.exist(err);
            clients[0].rejectTxProposal(txp, "wont sign", function(err, txp) {
              should.not.exist(err);
              clients[1].signTxProposal(txp, function(err, txp) {
                should.not.exist(err);
                done();
              });
            });
          });
        });
      });
    });

    it("Send, reject, 2 signs and broadcast in 2-3 wallet", function(done) {
      helpers.createAndJoinWallet(clients, 2, 3, function(w) {
        clients[0].createAddress(function(err, x0) {
          should.not.exist(err);
          should.exist(x0.address);
          blockchainExplorerMock.setUtxo(x0, 1e9);
          var opts = {
            app: 'payment',
            params: {
              outputs: [{
                amount: 10000000,
                address: "4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU",
              }]
            },
            message: "hello",
          };
          helpers.createAndPublishTxProposal(clients[0], opts, function(err, txp) {
            should.not.exist(err);
            txp.status.should.equal("pending");
            txp.requiredRejections.should.equal(2);
            txp.requiredSignatures.should.equal(2);
            clients[0].rejectTxProposal(txp, "wont sign", function(err, txp) {
              should.not.exist(err, err);
              txp.status.should.equal("pending");
              clients[1].signTxProposal(txp, function(err, txp) {
                should.not.exist(err);
                clients[2].signTxProposal(txp, function(err, txp) {
                  should.not.exist(err);
                  txp.status.should.equal("accepted");
                  clients[2].broadcastTxProposal(txp, function(err, txp) {
                    txp.status.should.equal("broadcasted");
                    done();
                  });
                });
              });
            });
          });
        });
      });
    });

    it("Send, reject in 3-4 wallet", function(done) {
      helpers.createAndJoinWallet(clients, 3, 4, function(w) {
        clients[0].createAddress(function(err, x0) {
          should.not.exist(err);
          should.exist(x0.address);
          blockchainExplorerMock.setUtxo(x0, 1e9);
          var opts = {
            app: 'payment',
            params: {
              outputs: [{
                amount: 10000000,
                address: "4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU",
              }]
            },
            message: "hello",
          };
          helpers.createAndPublishTxProposal(clients[0], opts, function(err, txp) {
            should.not.exist(err);
            txp.status.should.equal("pending");
            txp.requiredRejections.should.equal(2);
            txp.requiredSignatures.should.equal(3);

            clients[0].rejectTxProposal(txp, "wont sign", function(err, txp) {
              should.not.exist(err, err);
              txp.status.should.equal("pending");
              clients[1].signTxProposal(txp, function(err, txp) {
                should.not.exist(err);
                txp.status.should.equal("pending");
                clients[2].rejectTxProposal(txp, "me neither", function(err, txp) {
                  should.not.exist(err);
                  txp.status.should.equal("rejected");
                  done();
                });
              });
            });
          });
        });
      });
    });

    it("Should not allow to reject or sign twice", function(done) {
      helpers.createAndJoinWallet(clients, 2, 3, function(w) {
        clients[0].createAddress(function(err, x0) {
          should.not.exist(err);
          should.exist(x0.address);
          blockchainExplorerMock.setUtxo(x0, 1e9);
          var opts = {
            app: 'payment',
            params: {
              outputs: [{
                amount: 10000000,
                address: "4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU",
              }]
            },
            message: "hello",
          };
          helpers.createAndPublishTxProposal(clients[0], opts, function(err, txp) {
            should.not.exist(err);
            txp.status.should.equal("pending");
            txp.requiredRejections.should.equal(2);
            txp.requiredSignatures.should.equal(2);
            clients[0].signTxProposal(txp, function(err, txp) {
              should.not.exist(err);
              txp.status.should.equal("pending");
              clients[0].signTxProposal(txp, function(err) {
                should.exist(err);
                err.should.be.an.instanceOf(Errors.COPAYER_VOTED);
                clients[1].rejectTxProposal(txp, "xx", function(err, txp) {
                  should.not.exist(err);
                  clients[1].rejectTxProposal(txp, "xx", function(err) {
                    should.exist(err);
                    err.should.be.an.instanceOf(Errors.COPAYER_VOTED);
                    done();
                  });
                });
              });
            });
          });
        });
      });
    });
  });

  describe("Transaction history", function() {
    it("should get transaction history", function(done) {
      var txs = [{
        unit: '123',
        time: 1552832680
      }];
      helpers.stubHistory(txs);
      helpers.createAndJoinWallet(clients, 1, 1, function(w) {
        clients[0].createAddress(function(err, x0) {
          should.not.exist(err);
          should.exist(x0.address);
          clients[0].getTxHistory({}, function(err, txs) {
            should.not.exist(err);
            should.exist(txs);
            txs.length.should.equal(1);
            done();
          });
        });
      });
    });

    it("should not get transaction history when there are no addresses", function(done) {
      helpers.stubHistory([]);
      helpers.createAndJoinWallet(clients, 1, 1, function(w) {
        clients[0].getTxHistory({}, function(err, txs) {
          should.exist(err);
          done();
        });
      });
    });
  });

  describe("Transaction notes", function(done) {
    beforeEach(function(done) {
      helpers.createAndJoinWallet(clients, 1, 2, function(w) {
        done();
      });
    });

    it("should edit a note for an arbitrary txid", function(done) {
      clients[0].editTxNote(
        {
          txid: "123",
          body: "note body"
        },
        function(err, note) {
          should.not.exist(err);
          should.exist(note);
          note.body.should.equal("note body");
          clients[0].getTxNote(
            {
              txid: "123"
            },
            function(err, note) {
              should.not.exist(err);
              should.exist(note);
              note.txid.should.equal("123");
              note.walletId.should.equal(clients[0].copayer.walletId);
              note.body.should.equal("note body");
              note.editedBy.should.equal(clients[0].copayer.copayerId);
              note.editedByName.should.equal(
                clients[0].copayer.copayerName
              );
              note.createdOn.should.equal(note.editedOn);
              done();
            }
          );
        }
      );
    });

    it("should not send note body in clear text", function(done) {
      var spy = sinon.spy(clients[0], "_doPutRequest");
      clients[0].editTxNote(
        {
          txid: "123",
          body: "a random note"
        },
        function(err) {
          should.not.exist(err);
          var url = spy.getCall(0).args[0];
          var body = JSON.stringify(spy.getCall(0).args[1]);
          url.should.contain("/txnotes");
          body.should.contain("123");
          body.should.not.contain("a random note");
          done();
        }
      );
    });

    it("should share notes between copayers", function(done) {
      clients[0].editTxNote(
        {
          txid: "123",
          body: "note body"
        },
        function(err) {
          should.not.exist(err);
          clients[0].getTxNote(
            {
              txid: "123"
            },
            function(err, note) {
              should.not.exist(err);
              should.exist(note);
              note.editedBy.should.equal(clients[0].copayer.copayerId);
              var creator = note.editedBy;
              clients[1].getTxNote(
                {
                  txid: "123"
                },
                function(err, note) {
                  should.not.exist(err);
                  should.exist(note);
                  note.body.should.equal("note body");
                  note.editedBy.should.equal(creator);
                  done();
                }
              );
            }
          );
        }
      );
    });

    it("should get all notes edited past a given date", function(done) {
      var clock = sinon.useFakeTimers({ toFake: ["Date"] });
      async.series(
        [
          function(next) {
            clients[0].getTxNotes({}, function(err, notes) {
              should.not.exist(err);
              notes.should.be.empty;
              next();
            });
          },
          function(next) {
            clients[0].editTxNote(
              {
                txid: "123",
                body: "note body"
              },
              next
            );
          },
          function(next) {
            clients[0].getTxNotes(
              {
                minTs: 0
              },
              function(err, notes) {
                should.not.exist(err);
                notes.length.should.equal(1);
                notes[0].txid.should.equal("123");
                next();
              }
            );
          },
          function(next) {
            clock.tick(60 * 1000);
            clients[0].editTxNote(
              {
                txid: "456",
                body: "another note"
              },
              next
            );
          },
          function(next) {
            clients[0].getTxNotes(
              {
                minTs: 0
              },
              function(err, notes) {
                should.not.exist(err);
                notes.length.should.equal(2);
                _.difference(_.map(notes, "txid"), ["123", "456"]).should.be
                  .empty;
                next();
              }
            );
          },
          function(next) {
            clients[0].getTxNotes(
              {
                minTs: 50
              },
              function(err, notes) {
                should.not.exist(err);
                notes.length.should.equal(1);
                notes[0].txid.should.equal("456");
                next();
              }
            );
          },
          function(next) {
            clock.tick(60 * 1000);
            clients[0].editTxNote(
              {
                txid: "123",
                body: "an edit"
              },
              next
            );
          },
          function(next) {
            clients[0].getTxNotes(
              {
                minTs: 100
              },
              function(err, notes) {
                should.not.exist(err);
                notes.length.should.equal(1);
                notes[0].txid.should.equal("123");
                notes[0].body.should.equal("an edit");
                next();
              }
            );
          },
          function(next) {
            clients[0].getTxNotes({}, function(err, notes) {
              should.not.exist(err);
              notes.length.should.equal(2);
              next();
            });
          }
        ],
        function(err) {
          should.not.exist(err);
          clock.restore();
          done();
        }
      );
    });
  });

  describe("Mobility, backup & restore", function() {
    describe("Export & Import", function() {
      var address, importedClient;
      beforeEach(function(done) {
        importedClient = null;
        helpers.createAndJoinWallet(clients, 1, 1, function() {
          clients[0].createAddress(function(err, addr) {
            should.not.exist(err);
            should.exist(addr.address);
            address = addr.address;
            done();
          });
        });
      });
      afterEach(function(done) {
        if (!importedClient) return done();
        importedClient.getMainAddresses({}, function(err, list) {
          should.not.exist(err);
          should.exist(list);
          list.length.should.equal(1);
          list[0].address.should.equal(address);
          done();
        });
      });

      it("should export & import", function() {
        var exported = clients[0].export();
        importedClient = helpers.newClient(app);
        importedClient.import(exported);
      });

      it("should export without signing rights", function() {
        clients[0].canSign().should.be.true;
        var exported = clients[0].export({
          noSign: true
        });
        importedClient = helpers.newClient(app);
        importedClient.import(exported);
        importedClient.canSign().should.be.false;
      });

      it("should export & import encrypted", function() {
        clients[0].encryptPrivateKey("password");

        var exported = clients[0].export();

        importedClient = helpers.newClient(app);
        importedClient.import(exported);

        importedClient.isPrivKeyEncrypted().should.be.true;
      });

      it("should export & import decrypted when password is supplied", function() {
        clients[0].encryptPrivateKey("password");

        var exported = clients[0].export({
          password: "password"
        });

        importedClient = helpers.newClient(app);
        importedClient.import(exported);

        importedClient.isPrivKeyEncrypted().should.be.false;
        clients[0].isPrivKeyEncrypted().should.be.true;
        should.not.exist(clients[0].xPrivKey);
        should.not.exist(clients[0].mnemonic);
      });

      it("should fail if wrong password provided", function() {
        clients[0].encryptPrivateKey("password");

        var exported = clients[0].export({
          password: "password"
        });

        var err;
        try {
          var exported = clients[0].export({
            password: "wrong"
          });
        } catch (ex) {
          err = ex;
        }
        should.exist(err);
      });

      it("should export & import with mnemonics + OWS", function(done) {
        var d = clients[0].device;
        var c = clients[0].copayer;
        var walletId = c.walletId;
        var walletName = c.walletName;
        var copayerName = c.copayerName;
        var key = d.xPrivKey;

        var exported = clients[0].getMnemonic();
        importedClient = helpers.newClient(app);
        importedClient.importFromMnemonic(
          exported,
          {
            network: c.network
          },
          function(err) {
            var d2 = importedClient.device;
            var c2 = importedClient.copayer;
            d2.xPrivKey.should.equal(key);
            should.not.exist(err);
            c2.walletId.should.equal(walletId);
            c2.walletName.should.equal(walletName);
            c2.copayerName.should.equal(copayerName);
            done();
          }
        );
      });

      it("should export & import with xprivkey + OWS", function(done) {
        var d = clients[0].device;
        var c = clients[0].copayer;
        var walletId = c.walletId;
        var walletName = c.walletName;
        var copayerName = c.copayerName;
        var network = d.network;
        var key = d.xPrivKey;

        var exported = clients[0].getMnemonic();
        importedClient = helpers.newClient(app);
        importedClient.importFromExtendedPrivateKey(key, function(err) {
          var d2 = importedClient.device;
          var c2 = importedClient.copayer;
          d2.xPrivKey.should.equal(key);
          should.not.exist(err);
          c2.walletId.should.equal(walletId);
          c2.walletName.should.equal(walletName);
          c2.copayerName.should.equal(copayerName);
          done();
        });
      });
    });

    describe("#validateKeyDerivation", function() {
      beforeEach(function(done) {
        helpers.createAndJoinWallet(clients, 1, 1, function() {
          done();
        });
      });
      it("should validate key derivation", function(done) {
        clients[0].validateKeyDerivation({}, function(err, isValid) {
          should.not.exist(err);
          isValid.should.be.true;
          clients[0].keyDerivationOk.should.be.true;

          var exported = JSON.parse(clients[0].export());

          // Tamper export with a wrong xpub
          exported.xPubKey =
            "tpubD6NzVbkrYhZ4XJEQQWBgysPKJcBv8zLhHpfhcw4RyhakMxmffNRRRFDUe1Zh7fxvjt1FdNJcaxHgqxyKLL8XiZug7C8KJFLFtGfPVBcY6Nb";

          var importedClient = helpers.newClient(app);
          should.not.exist(importedClient.keyDerivationOk);

          importedClient.import(JSON.stringify(exported));
          importedClient.validateKeyDerivation({}, function(err, isValid) {
            should.not.exist(err);
            isValid.should.be.false;
            importedClient.keyDerivationOk.should.be.false;
            done();
          });
        });
      });
    });

    describe("Mnemonic related tests", function() {
      var importedClient;

      it("should import with mnemonics livenet", function(done) {
        var client = helpers.newClient(app);
        client.seedFromRandomWithMnemonic();
        var exported = client.getMnemonic();
        client.createWallet( "mywallet", "creator", 1, 1, { network: "livenet" },
          function(err) {
            should.not.exist(err);
            var d = client.device;
            var c = client.copayer;
            importedClient = helpers.newClient(app);
            importedClient.importFromMnemonic(exported, {}, function(err) {
              should.not.exist(err);
              var d2 = importedClient.device;
              var c2 = importedClient.copayer;
              d2.network.should.equal("livenet");
              d2.xPubKey.should.equal(d.xPubKey);
              d2.personalEncryptingKey.should.equal(d.personalEncryptingKey);
              c2.walletId.should.equal(c.walletId);
              c2.walletName.should.equal(c.walletName);
              c2.copayerName.should.equal(c.copayerName);
              done();
            });
          }
        );
      });
    });

    describe("Recovery", function() {
      var db2;
      before(done => {
        helpers.newDb(2, (err, in_db) => {
          db2 = in_db;
          return done(err);
        });
      });

      it("should be able to gain access to a 1-1 wallet with just the xPriv", function(done) {
        helpers.createAndJoinWallet(clients, 1, 1, function() {
          var xpriv = clients[0].device.xPrivKey;
          var walletName = clients[0].copayer.walletName;
          var copayerName = clients[0].copayer.copayerName;

          clients[0].createAddress(function(err, addr) {
            should.not.exist(err);
            should.exist(addr);

            var recoveryClient = helpers.newClient(app);
            recoveryClient.seedFromExtendedPrivateKey(xpriv);
            recoveryClient.openWallet(function(err) {
              should.not.exist(err);
              recoveryClient.copayer.walletName.should.equal(walletName);
              recoveryClient.copayer.copayerName.should.equal(copayerName);
              recoveryClient.getMainAddresses({}, function(err, list) {
                should.not.exist(err);
                should.exist(list);
                list[0].address.should.equal(addr.address);
                done();
              });
            });
          });
        });
      });

      it("should be able to see txp messages after gaining access", function(done) {
        helpers.createAndJoinWallet(clients, 1, 1, function() {
          var xpriv = clients[0].device.xPrivKey;
          var walletName = clients[0].copayer.walletName;
          clients[0].createAddress(function(err, x0) {
            should.not.exist(err);
            should.exist(x0.address);
            blockchainExplorerMock.setUtxo(x0, 1e9);
            var opts = {
              app: 'payment',
              params: {
                outputs: [{
                  amount: 30000,
                  address: "4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU",
                }]
              },
              message: "hello"
            };
            helpers.createAndPublishTxProposal(clients[0], opts, function( err, x ) {
              should.not.exist(err);
              var recoveryClient = helpers.newClient(app);
              recoveryClient.seedFromExtendedPrivateKey(xpriv);
              recoveryClient.openWallet(function(err) {
                should.not.exist(err);
                recoveryClient.copayer.walletName.should.equal(walletName);
                recoveryClient.getTx(x.id, function(err, x2) {
                  should.not.exist(err);
                  x2.message.should.equal(opts.message);
                  done();
                });
              });
            });
          });
        });
      });

      it("should be able to recreate wallet 2-2", function(done) {
        helpers.createAndJoinWallet(clients, 2, 2, function() {
          clients[0].createAddress(function(err, addr) {
            should.not.exist(err);
            should.exist(addr);

            var storage = new Storage({
              db: db2
            });

            var newApp;
            var expressApp = new ExpressApp();
            expressApp.start(
              {
                storage: storage,
                blockchainExplorer: blockchainExplorerMock,
                disableLogs: true
              },
              function() {
                newApp = expressApp.app;

                var oldPKR = _.clone(clients[0].copayer.publicKeyRing);
                var recoveryClient = helpers.newClient(newApp);
                recoveryClient.import(clients[0].export());

                recoveryClient.getStatus({}, function(err, status) {
                  should.exist(err);
                  err.should.be.an.instanceOf(Errors.NOT_AUTHORIZED);
                  var spy = sinon.spy(recoveryClient, "_doPostRequest");
                  recoveryClient.recreateWallet(function(err) {
                    should.not.exist(err);

                    // Do not send wallet name and copayer names in clear text
                    var url = spy.getCall(0).args[0];
                    var body = JSON.stringify(spy.getCall(0).args[1]);
                    url.should.contain("/wallets");
                    body.should.not.contain("mywallet");
                    var url = spy.getCall(1).args[0];
                    var body = JSON.stringify(spy.getCall(1).args[1]);
                    url.should.contain("/copayers");
                    body.should.not.contain("creator");
                    body.should.not.contain("copayer 1");

                    recoveryClient.getStatus({}, function(err, status) {
                      should.not.exist(err);
                      status.wallet.name.should.equal("mywallet");
                      _.difference(_.map(status.wallet.copayers, "name"), [
                        "creator",
                        "copayer 1"
                      ]).length.should.equal(0);
                      recoveryClient.createAddress(function(err, addr2) {
                        should.not.exist(err);
                        should.exist(addr2);
                        addr2.address.should.equal(addr.address);
                        addr2.path.should.equal(addr.path);

                        var recoveryClient2 = helpers.newClient(newApp);
                        recoveryClient2.import(clients[1].export());
                        recoveryClient2.getStatus({}, function(err, status) {
                          should.not.exist(err);
                          done();
                        });
                      });
                    });
                  });
                });
              }
            );
          });
        });
      });

      it("should be able to recover funds from recreated wallet", function(done) {
        this.timeout(10000);
        helpers.createAndJoinWallet(clients, 2, 2, function() {
          clients[0].createAddress(function(err, addr) {
            should.not.exist(err);
            should.exist(addr);
            blockchainExplorerMock.setUtxo(addr, 1e9);

            var storage = new Storage({
              db: db2
            });
            var newApp;
            var expressApp = new ExpressApp();
            expressApp.start(
              {
                storage: storage,
                blockchainExplorer: blockchainExplorerMock,
                disableLogs: true
              },
              function() {
                newApp = expressApp.app;

                var recoveryClient = helpers.newClient(newApp);
                recoveryClient.import(clients[0].export());

                recoveryClient.getStatus({}, function(err, status) {
                  should.exist(err);
                  err.should.be.an.instanceOf(Errors.NOT_AUTHORIZED);
                  recoveryClient.recreateWallet(function(err) {
                    should.not.exist(err);
                    recoveryClient.getStatus({}, function(err, status) {
                      should.not.exist(err);
                      recoveryClient.startScan({}, function(err) {
                        should.not.exist(err);
                        var balance = 0;
                        async.whilst(
                          function() {
                            return balance == 0;
                          },
                          function(next) {
                            setTimeout(function() {
                              recoveryClient.getBalance({}, function(err, b) {
                                balance = b;
                                next(err);
                              });
                            }, 200);
                          },
                          function(err) {
                            should.not.exist(err);
                            done();
                          }
                        );
                      });
                    });
                  });
                });
              }
            );
          });
        });
      });

      it("should be able call recreate wallet twice", function(done) {
        this.timeout(60000);
        helpers.createAndJoinWallet(clients, 2, 2, function() {
          clients[0].createAddress(function(err, addr) {
            should.not.exist(err);
            should.exist(addr);

            var storage = new Storage({
              db: db2
            });
            var newApp;
            var expressApp = new ExpressApp();
            expressApp.start(
              {
                storage: storage,
                blockchainExplorer: blockchainExplorerMock,
                disableLogs: true
              },
              function() {
                newApp = expressApp.app;

                var oldPKR = _.clone(clients[0].copayer.publicKeyRing);
                var recoveryClient = helpers.newClient(newApp);
                recoveryClient.import(clients[0].export());

                recoveryClient.getStatus({}, function(err, status) {
                  should.exist(err);
                  err.should.be.an.instanceOf(Errors.NOT_AUTHORIZED);
                  recoveryClient.recreateWallet(function(err) {
                    should.not.exist(err);
                    recoveryClient.recreateWallet(function(err) {
                      should.not.exist(err);
                      recoveryClient.getStatus({}, function(err, status) {
                        should.not.exist(err);
                        _.difference(_.map(status.wallet.copayers, "name"), [
                          "creator",
                          "copayer 1"
                        ]).length.should.equal(0);
                        recoveryClient.createAddress(function(err, addr2) {
                          should.not.exist(err);
                          should.exist(addr2);
                          addr2.address.should.equal(addr.address);
                          addr2.path.should.equal(addr.path);

                          var recoveryClient2 = helpers.newClient(newApp);
                          recoveryClient2.import(clients[1].export());
                          recoveryClient2.getStatus({}, function(err, status) {
                            should.not.exist(err);
                            done();
                          });
                        });
                      });
                    });
                  });
                });
              }
            );
          });
        });
      });
    });
  });

  describe("Private key encryption", function() {
    var password = "jesuissatoshi";
    var c1, c2;
    var importedClient;

    beforeEach(function(done) {
      c1 = clients[1];
      clients[1].seedFromRandomWithMnemonic({ network: "testnet" });
      clients[1].createWallet( "mywallet", "creator", 1, 1, { network: "testnet" },
        function() {
          clients[1].encryptPrivateKey(password);
          done();
        }
      );
    });
    it("should fail to decrypt if not encrypted", function(done) {
      helpers.createAndJoinWallet(clients, 1, 1, function() {
        (function() {
          clients[0].decryptPrivateKey("wrong");
        }.should.throw("encrypted"));
        done();
      });
    });
    it("should return priv key is not encrypted", function(done) {
      helpers.createAndJoinWallet(clients, 1, 1, function() {
        clients[0].isPrivKeyEncrypted().should.be.false;
        done();
      });
    });
    it("should return priv key is encrypted", function() {
      c1.isPrivKeyEncrypted().should.be.true;
    });
    it("should prevent to reencrypt the priv key", function() {
      (function() {
        c1.encryptPrivateKey("pepe");
      }.should.throw("Private key already encrypted"));
    });
    it("should allow to decrypt", function() {
      c1.decryptPrivateKey(password);
      c1.isPrivKeyEncrypted().should.be.false;
    });
    it("should not contain unencrypted fields when encrypted", function() {
      var keys = c1.getKeys(password);
      c1.isPrivKeyEncrypted().should.be.true;
      var str = JSON.stringify(c1);
      str.indexOf(keys.xPrivKey).should.equal(-1);
      str.indexOf(keys.mnemonic).should.equal(-1);
    });
    it("should restore cleartext fields when decrypting", function() {
      var keys = c1.getKeys(password);
      (function() {
        c1.getMnemonic();
      }.should.throw("encrypted"));
      c1.decryptPrivateKey(password);
      c1.device.xPrivKey.should.equal(keys.xPrivKey);
      c1.getMnemonic().should.equal(keys.mnemonic);
    });
    it("should fail to decrypt with wrong password", function() {
      (function() {
        c1.decryptPrivateKey("wrong");
      }.should.throw("Could not decrypt"));
    });
    it("should export & import encrypted", function(done) {
      var walletId = c1.copayer.walletId;
      var walletName = c1.copayer.walletName;
      var copayerName = c1.copayer.copayerName;
      var exported = c1.export({});
      importedClient = helpers.newClient(app);
      importedClient.import(exported, {});
      importedClient.openWallet(function(err) {
        should.not.exist(err);
        importedClient.copayer.walletId.should.equal(walletId);
        importedClient.copayer.walletName.should.equal(walletName);
        importedClient.copayer.copayerName.should.equal(copayerName);
        importedClient.isPrivKeyEncrypted().should.equal(true);
        importedClient.decryptPrivateKey(password);
        importedClient.isPrivKeyEncrypted().should.equal(false);
        done();
      });
    });
    it("should check right password", function() {
      var valid = c1.checkPassword(password);
      valid.should.equal(true);
    });
    it("should failt to check wrong password", function() {
      var valid = c1.checkPassword("x");
      valid.should.equal(false);
    });

    it("should fail to sign when encrypted and no password is provided", function(done) {
      c1.createAddress(function(err, x0) {
        should.not.exist(err);
        blockchainExplorerMock.setUtxo(x0, 1, 1);
        var opts = {
          app: 'payment',
          params: {
            outputs: [{
              amount: 30000,
              address: "4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU",
            }]
          },
          message: "hello"
        };
        helpers.createAndPublishTxProposal(c1, opts, function(err, txp) {
          should.not.exist(err);
          c1.signTxProposal(txp, function(err) {
            err.message.should.contain("encrypted");
            done();
          });
        });
      });
    });
    it("should sign when encrypted and password provided", function(done) {
      c1.createAddress(function(err, x0) {
        should.not.exist(err);
        blockchainExplorerMock.setUtxo(x0, 1, 1);
        var opts = {
          app: 'payment',
          params: {
            outputs: [{
              amount: 30000,
              address: "4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU",
            }]
          },
          message: "hello"
        };
        helpers.createAndPublishTxProposal(c1, opts, function(err, txp) {
          should.not.exist(err);
          c1.signTxProposal(txp, password, function(err) {
            should.not.exist(err);
            c1.isPrivKeyEncrypted().should.be.true;
            done();
          });
        });
      });
    });
    it("should fail to sign when encrypted and incorrect password", function(done) {
      c1.createAddress(function(err, x0) {
        should.not.exist(err);
        blockchainExplorerMock.setUtxo(x0, 1, 1);
        var opts = {
          app: 'payment',
          params: {
            outputs: [{
              amount: 30000,
              address: "4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU",
            }]
          },
          message: "hello"
        };
        helpers.createAndPublishTxProposal(c1, opts, function(err, txp) {
          should.not.exist(err);
          c1.signTxProposal(txp, "wrong", function(err) {
            err.message.should.contain("not decrypt");
            done();
          });
        });
      });
    });
  });

  describe("#addAccess", function() {
    describe("1-1 wallets", function() {
      var opts;

      beforeEach(function(done) {
        opts = {
          app: 'payment',
          params: {
            outputs: [{
              amount: 30000,
              address: "4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU",
            }]
          },
          message: "hello"
        };

        helpers.createAndJoinWallet(clients, 1, 1, function() {
          clients[0].createAddress(function(err, x0) {
            should.not.exist(err);
            blockchainExplorerMock.setUtxo(x0, 1e9);
            var d = clients[0].device;

            // Ggenerate a new priv key, not registered
            var k = new Bitcore.PrivateKey();
            d.requestPrivKey = k.toString();
            d.requestPubKey = k.toPublicKey().toString();
            done();
          });
        });
      });

      it("should deny access before registering it ", function(done) {
        helpers.createAndPublishTxProposal(clients[0], opts, function(err, x) {
          err.should.be.an.instanceOf(Errors.NOT_AUTHORIZED);
          done();
        });
      });

      it("should grant access with current keys", function(done) {
        clients[0].addAccess({}, function(err, x) {
          helpers.createAndPublishTxProposal(clients[0], opts, function( err, x ) {
            console.log(err);
            should.not.exist(err);
            done();
          });
        });
      });

      it("should add access with copayer name", function(done) {
        var spy = sinon.spy(clients[0], "_doPutRequest");
        clients[0].addAccess( { name: "pepe" },
          function(err, x, key) {
            should.not.exist(err);
            var url = spy.getCall(0).args[0];
            var body = JSON.stringify(spy.getCall(0).args[1]);
            url.should.contain("/copayers");
            body.should.not.contain("pepe");

            var k = new Bitcore.PrivateKey(key);
            var d = clients[0].device;
            d.requestPrivKey = k.toString();
            d.requestPubKey = k.toPublicKey().toString();

            clients[0].getStatus({}, function(err, status) {
              should.not.exist(err);
              var keys = status.wallet.copayers[0].requestPubKeys;
              keys.length.should.equal(2);
              _.filter(keys, {
                name: "pepe"
              }).length.should.equal(1);

              helpers.createAndPublishTxProposal(clients[0], opts, function( err, x ) {
                should.not.exist(err);
                // TODO: verify tx's creator is 'pepe'
                done();
              });
            });
          }
        );
      });

      it("should grant access with *new* keys then deny access with old keys", function(done) {
        clients[0].addAccess( { generateNewKey: true },
          function(err, x) {
            helpers.createAndPublishTxProposal(clients[0], opts, function( err, x ) {
              err.should.be.an.instanceOf(Errors.NOT_AUTHORIZED);
              done();
            });
          }
        );
      });

      it("should grant access with new keys", function(done) {
        clients[0].addAccess( { generateNewKey: true },
          function(err, x, key) {
            var k = new Bitcore.PrivateKey(key);
            var d = clients[0].device;
            d.requestPrivKey = k.toString();
            d.requestPubKey = k.toPublicKey().toString();
            helpers.createAndPublishTxProposal(clients[0], opts, function( err, x ) {
              should.not.exist(err);
              done();
            });
          }
        );
      });
    });
  });

  describe("_initNotifications", function() {
    it("should handle NOT_FOUND error from _fetchLatestNotifications", function(done) {
      var sandbox = sinon.sandbox.create();
      var clock = sandbox.useFakeTimers();

      var client = new Client();

      var _f = sandbox
        .stub(client, "_fetchLatestNotifications")
        .callsFake(function(interval, cb) {
          cb(new Errors.NOT_FOUND());
        });

      client._initNotifications({
        notificationIntervalSeconds: 1
      });
      should.exist(client.notificationsIntervalId);
      clock.tick(1000);
      should.not.exist(client.notificationsIntervalId);
      sandbox.restore();
      done();
    });

    it("should handle NOT_AUTHORIZED error from _fetLatestNotifications", function(done) {
      var sandbox = sinon.sandbox.create();
      var clock = sandbox.useFakeTimers();

      var client = new Client();

      var _f = sandbox
        .stub(client, "_fetchLatestNotifications")
        .callsFake(function(interval, cb) {
          cb(new Errors.NOT_AUTHORIZED());
        });

      client._initNotifications({
        notificationIntervalSeconds: 1
      });
      should.exist(client.notificationsIntervalId);
      clock.tick(1000);
      should.not.exist(client.notificationsIntervalId);
      sandbox.restore();
      done();
    });
  });

  describe("Import", function() {
    describe("#import", function(done) {
      it("should handle import with invalid JSON", function(done) {
        var importString = "this is not valid JSON";
        var client = new Client();
        (function() {
          client.import(importString);
        }.should.throw(Errors.INVALID_BACKUP));
        done();
      });
    });

    describe("#importFromMnemonic", function() {
      it("should handle importing an invalid mnemonic", function(done) {
        var client = new Client();
        var mnemonicWords = "this is an invalid mnemonic";
        client.importFromMnemonic(mnemonicWords, {}, function(err) {
          should.exist(err);
          err.should.be.an.instanceOf(Errors.INVALID_BACKUP);
          done();
        });
      });
    });

    describe("#importFromExtendedPrivateKey", function() {
      it("should handle importing an invalid extended private key", function(done) {
        var client = new Client();
        var xPrivKey = "this is an invalid key";
        client.importFromExtendedPrivateKey(xPrivKey, function(err) {
          should.exist(err);
          err.should.be.an.instanceOf(Errors.INVALID_BACKUP);
          done();
        });
      });
    });
  });

  describe("_doRequest", function() {
    it("should handle connection error", function(done) {
      var client = new Client();
      client.credentials = {};
      client.request = helpers.stubRequest(null, {});
      client._doRequest("get", "url", {}, false, function(err, body, header) {
        should.exist(err);
        should.not.exist(body);
        should.not.exist(header);
        err.should.be.an.instanceOf(Errors.CONNECTION_ERROR);
        done();
      });
    });

    it("should handle ECONNRESET error", function(done) {
      var client = new Client();
      client.credentials = {};
      client.request = helpers.stubRequest(null, {
        status: 200,
        body: '{"error":"read ECONNRESET"}'
      });
      client._doRequest("get", "url", {}, false, function(err, body, header) {
        should.exist(err);
        should.not.exist(body);
        should.not.exist(header);
        err.should.be.an.instanceOf(Errors.ECONNRESET_ERROR);
        done();
      });
    });
  });

  describe("Single-address wallets", function() {
    beforeEach(function(done) {
      helpers.createAndJoinWallet(clients, 1, 2, { singleAddress: true },
        function(wallet) {
          done();
        }
      );
    });
    it("should always return same address", function(done) {
      clients[0].createAddress(function(err, x) {
        should.not.exist(err);
        should.exist(x);
        x.path.should.equal("m/0/0");
        clients[0].createAddress(function(err, y) {
          should.not.exist(err);
          should.exist(y);
          y.path.should.equal("m/0/0");
          y.address.should.equal(x.address);
          clients[1].createAddress(function(err, z) {
            should.not.exist(err);
            should.exist(z);
            z.path.should.equal("m/0/0");
            z.address.should.equal(x.address);
            clients[0].getMainAddresses({}, function(err, addr) {
              should.not.exist(err);
              addr.length.should.equal(1);
              done();
            });
          });
        });
      });
    });
    it("should reuse address as change address on tx proposal creation", function(done) {
      clients[0].createAddress(function(err, address) {
        should.not.exist(err);
        should.exist(address.address);
        blockchainExplorerMock.setUtxo(address, 2e9);

        var opts = {
          app: 'payment',
          params: {
            outputs: [{
              address: '4MEMP3JRUCKEQ2ELT2GQCK2L4X6YQQWU',
              amount: 1e9
            }]
          }
        };
        opts = helpers.composeJoint(opts);
        clients[0].createTxProposal(opts, function(err, txp) {
          should.not.exist(err);
          should.exist(txp);
          should.exist(txp.changeAddress);
          txp.changeAddress.should.equal(address.address);
          done();
        });
      });
    });
  });
});
