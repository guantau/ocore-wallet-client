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

Constants.UNITS = {
  giga: {
    toBytes: 1000000000,
    full: {
      maxDecimals: 9,
      minDecimals: 9,
    },
    short: {
      maxDecimals: 7,
      minDecimals: 2,
    }
  },
  mega: {
    toBytes: 1000000,
    full: {
      maxDecimals: 6,
      minDecimals: 6,
    },
    short: {
      maxDecimals: 4,
      minDecimals: 2,
    }
  },
  kilo: {
    toBytes: 1000,
    full: {
      maxDecimals: 3,
      minDecimals: 3,
    },
    short: {
      maxDecimals: 2,
      minDecimals: 1,
    }
  },
  one: {
    toBytes: 1,
    full: {
      maxDecimals: 0,
      minDecimals: 0,
    },
    short: {
      maxDecimals: 0,
      minDecimals: 0,
    }
  },
};

Constants.bTestnet = !!process.env.testnet;
Constants.versionWithoutTimestamp = Constants.bTestnet ? '1.0t' : '1.0';

module.exports = Constants;
