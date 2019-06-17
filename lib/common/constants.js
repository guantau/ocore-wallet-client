'use strict';

var Constants = {};

Constants.ADDRESS_TYPES = {
  NORMAL: 'normal',
  SHARED: 'shared',
  SCRIPT: 'script'
};

Constants.DERIVATION_STRATEGIES = {
  BIP44: 'BIP44',
  BIP45: 'BIP45',
  BIP48: 'BIP48'
};

Constants.PATHS = {
  DEVICE_KEY: "m/1'",
  REQUEST_KEY: "m/1'/0",
  TXPROPOSAL_KEY: "m/1'/1",
  REQUEST_KEY_AUTH: "m/2", // relative to BASE
};

Constants.BIP45_SHARED_INDEX = 0x80000000 - 1;

Constants.bTestnet = !!process.env.testnet;
Constants.versionWithoutTimestamp = Constants.bTestnet ? '1.0t' : '1.0';

module.exports = Constants;
