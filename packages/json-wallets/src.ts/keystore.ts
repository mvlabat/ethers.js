"use strict";

import aes from "aes-js";
import { scrypt } from "scrypt-js";
import uuid from "uuid";

import { ExternallyOwnedAccount } from "@ethersproject/abstract-signer";
import { getAddress } from "@ethersproject/address";
import { arrayify, Bytes, BytesLike, concat, hexlify } from "@ethersproject/bytes";
import { defaultPath, entropyToMnemonic, HDNode, mnemonicToEntropy } from "@ethersproject/hdnode";
import { keccak256 } from "@ethersproject/keccak256";
import { pbkdf2 } from "@ethersproject/pbkdf2";
import { randomBytes } from "@ethersproject/random";
import { Description } from "@ethersproject/properties";
import { computeAddress } from "@ethersproject/transactions";

import { getPassword, looseArrayify, searchPath, zpad } from "./utils";

// Exported Types

export class KeystoreAccount extends Description implements ExternallyOwnedAccount {
    readonly address: string;
    readonly privateKey: string;
    readonly mnemonic?: string;
    readonly path?: string;

    readonly _isKeystoreAccount: boolean;

    isKeystoreAccount(value: any): value is KeystoreAccount {
        return !!(value && value._isKeystoreAccount);
    }
}

export type ProgressCallback = (percent: number) => void;

export type EncryptOptions = {
   iv?: BytesLike;
   entropy?: BytesLike;
   client?: string;
   salt?: BytesLike;
   uuid?: string;
   scrypt?: {
       N?: number;
       r?: number;
       p?: number;
   }
}

export async function decrypt(json: string, password: Bytes | string, progressCallback?: ProgressCallback): Promise<KeystoreAccount> {
    const data = JSON.parse(json);

    const passwordBytes = getPassword(password);

    const decrypt = function(key: Uint8Array, ciphertext: Uint8Array): Uint8Array {
        const cipher = searchPath(data, "crypto/cipher");
        if (cipher === "aes-128-ctr") {
            const iv = looseArrayify(searchPath(data, "crypto/cipherparams/iv"))
            const counter = new aes.Counter(iv);

            const aesCtr = new aes.ModeOfOperation.ctr(key, counter);

            return arrayify(aesCtr.decrypt(ciphertext));
        }

        return null;
    };

    const computeMAC = function(derivedHalf: Uint8Array, ciphertext: Uint8Array) {
        return keccak256(concat([ derivedHalf, ciphertext ]));
    }

    const getAccount = async function(key: Uint8Array): Promise<KeystoreAccount> {
        const ciphertext = looseArrayify(searchPath(data, "crypto/ciphertext"));

        const computedMAC = hexlify(computeMAC(key.slice(16, 32), ciphertext)).substring(2);
        if (computedMAC !== searchPath(data, "crypto/mac").toLowerCase()) {
            throw new Error("invalid password");
        }

        const privateKey = decrypt(key.slice(0, 16), ciphertext);
        const mnemonicKey = key.slice(32, 64);

        if (!privateKey) {
            throw new Error("unsupported cipher");
        }

        const address = computeAddress(privateKey);
        if (data.address) {
            let check = data.address.toLowerCase();
            if (check.substring(0, 2) !== "0x") { check = "0x" + check; }

            if (getAddress(check) !== address) {
                throw new Error("address mismatch");
            }
        }

        const account: any = {
            _isKeystoreAccount: true,
            address: address,
            privateKey: hexlify(privateKey)
        };

        // Version 0.1 x-ethers metadata must contain an encrypted mnemonic phrase
        if (searchPath(data, "x-ethers/version") === "0.1") {
            const mnemonicCiphertext = looseArrayify(searchPath(data, "x-ethers/mnemonicCiphertext"));
            const mnemonicIv = looseArrayify(searchPath(data, "x-ethers/mnemonicCounter"));

            const mnemonicCounter = new aes.Counter(mnemonicIv);
            const mnemonicAesCtr = new aes.ModeOfOperation.ctr(mnemonicKey, mnemonicCounter);

            const path = searchPath(data, "x-ethers/path") || defaultPath;

            const entropy = arrayify(mnemonicAesCtr.decrypt(mnemonicCiphertext));
            const mnemonic = entropyToMnemonic(entropy);

            const node = HDNode.fromMnemonic(mnemonic).derivePath(path);

            if (node.privateKey != account.privateKey) {
                throw new Error("mnemonic mismatch");
            }

            account.mnemonic = node.mnemonic;
            account.path = node.path;
        }

        return new KeystoreAccount(account);
    }


    const kdf = searchPath(data, "crypto/kdf");
    if (kdf && typeof(kdf) === "string") {
        if (kdf.toLowerCase() === "scrypt") {
            const salt = looseArrayify(searchPath(data, "crypto/kdfparams/salt"));
            const N = parseInt(searchPath(data, "crypto/kdfparams/n"));
            const r = parseInt(searchPath(data, "crypto/kdfparams/r"));
            const p = parseInt(searchPath(data, "crypto/kdfparams/p"));
            if (!N || !r || !p) {
                throw new Error("unsupported key-derivation function parameters");
            }

            // Make sure N is a power of 2
            if ((N & (N - 1)) !== 0) {
                throw new Error("unsupported key-derivation function parameter value for N");
            }

            const dkLen = parseInt(searchPath(data, "crypto/kdfparams/dklen"));
            if (dkLen !== 32) {
                throw new Error("unsupported key-derivation derived-key length");
            }

            const key = await scrypt(passwordBytes, salt, N, r, p, 64, progressCallback);
            //key = arrayify(key);

            return getAccount(key);

        } else if (kdf.toLowerCase() === "pbkdf2") {

            const salt = looseArrayify(searchPath(data, "crypto/kdfparams/salt"));

            let prfFunc: string = null;
            const prf = searchPath(data, "crypto/kdfparams/prf");
            if (prf === "hmac-sha256") {
                prfFunc = "sha256";
            } else if (prf === "hmac-sha512") {
                prfFunc = "sha512";
            } else {
                throw new Error("unsupported prf");
            }

            const c = parseInt(searchPath(data, "crypto/kdfparams/c"));

            const dkLen = parseInt(searchPath(data, "crypto/kdfparams/dklen"));
            if (dkLen !== 32) {
                throw new Error("unsupported key-derivation derived-key length");
            }

            const key = arrayify(pbkdf2(passwordBytes, salt, c, dkLen, prfFunc));

            return getAccount(key);
        }
    }
    throw new Error("unsupported key-derivation function");
}

export function encrypt(account: ExternallyOwnedAccount, password: Bytes | string, options?: EncryptOptions, progressCallback?: ProgressCallback): Promise<string> {

    try {
        if (getAddress(account.address) !== computeAddress(account.privateKey)) {
            throw new Error("address/privateKey mismatch");
        }

        if (account.mnemonic != null){
            const node = HDNode.fromMnemonic(account.mnemonic).derivePath(account.path || defaultPath);

            if (node.privateKey != account.privateKey) {
                throw new Error("mnemonic mismatch");
            }
        } else if (account.path != null) {
            throw new Error("cannot specify path without mnemonic");
        }

    } catch (e) {
        return Promise.reject(e);
    }

    // the options are optional, so adjust the call as needed
    if (typeof(options) === "function" && !progressCallback) {
        progressCallback = options;
        options = {};
    }
    if (!options) { options = {}; }

    const privateKey: Uint8Array = arrayify(account.privateKey);
    const passwordBytes = getPassword(password);

    let entropy: Uint8Array = null
    let path: string = account.path;
    if (account.mnemonic) {
        entropy = arrayify(mnemonicToEntropy(account.mnemonic));
        if (!path) { path = defaultPath; }
    }

    let client = options.client;
    if (!client) { client = "ethers.js"; }

    // Check/generate the salt
    let salt: Uint8Array = null;
    if (options.salt) {
        salt = arrayify(options.salt);
    } else {
        salt = randomBytes(32);;
    }

    // Override initialization vector
    let iv: Uint8Array = null;
    if (options.iv) {
        iv = arrayify(options.iv);
        if (iv.length !== 16) { throw new Error("invalid iv"); }
    } else {
       iv = randomBytes(16);
    }

    // Override the uuid
    let uuidRandom: Uint8Array = null;
    if (options.uuid) {
        uuidRandom = arrayify(options.uuid);
        if (uuidRandom.length !== 16) { throw new Error("invalid uuid"); }
    } else {
        uuidRandom = randomBytes(16);
    }

    // Override the scrypt password-based key derivation function parameters
    let N = (1 << 17), r = 8, p = 1;
    if (options.scrypt) {
        if (options.scrypt.N) { N = options.scrypt.N; }
        if (options.scrypt.r) { r = options.scrypt.r; }
        if (options.scrypt.p) { p = options.scrypt.p; }
    }

    // We take 64 bytes:
    //   - 32 bytes   As normal for the Web3 secret storage (derivedKey, macPrefix)
    //   - 32 bytes   AES key to encrypt mnemonic with (required here to be Ethers Wallet)
    return scrypt(passwordBytes, salt, N, r, p, 64, progressCallback).then((key) => {
        key = arrayify(key);

        // This will be used to encrypt the wallet (as per Web3 secret storage)
        const derivedKey = key.slice(0, 16);
        const macPrefix = key.slice(16, 32);

        // This will be used to encrypt the mnemonic phrase (if any)
        const mnemonicKey = key.slice(32, 64);

        // Encrypt the private key
        const counter = new aes.Counter(iv);
        const aesCtr = new aes.ModeOfOperation.ctr(derivedKey, counter);
        const ciphertext = arrayify(aesCtr.encrypt(privateKey));

        // Compute the message authentication code, used to check the password
        const mac = keccak256(concat([macPrefix, ciphertext]))

        // See: https://github.com/ethereum/wiki/wiki/Web3-Secret-Storage-Definition
        const data: { [key: string]: any } = {
            address: account.address.substring(2).toLowerCase(),
            id: uuid.v4({ random: uuidRandom }),
            version: 3,
            Crypto: {
                cipher: "aes-128-ctr",
                cipherparams: {
                    iv: hexlify(iv).substring(2),
                },
                ciphertext: hexlify(ciphertext).substring(2),
                kdf: "scrypt",
                kdfparams: {
                    salt: hexlify(salt).substring(2),
                    n: N,
                    dklen: 32,
                    p: p,
                    r: r
                },
                mac: mac.substring(2)
            }
        };

        // If we have a mnemonic, encrypt it into the JSON wallet
        if (entropy) {
            const mnemonicIv = randomBytes(16);
            const mnemonicCounter = new aes.Counter(mnemonicIv);
            const mnemonicAesCtr = new aes.ModeOfOperation.ctr(mnemonicKey, mnemonicCounter);
            const mnemonicCiphertext = arrayify(mnemonicAesCtr.encrypt(entropy));
            const now = new Date();
            const timestamp = (now.getUTCFullYear() + "-" +
                               zpad(now.getUTCMonth() + 1, 2) + "-" +
                               zpad(now.getUTCDate(), 2) + "T" +
                               zpad(now.getUTCHours(), 2) + "-" +
                               zpad(now.getUTCMinutes(), 2) + "-" +
                               zpad(now.getUTCSeconds(), 2) + ".0Z"
                              );
            data["x-ethers"] = {
                client: client,
                gethFilename: ("UTC--" + timestamp + "--" + data.address),
                mnemonicCounter: hexlify(mnemonicIv).substring(2),
                mnemonicCiphertext: hexlify(mnemonicCiphertext).substring(2),
                path: path,
                version: "0.1"
            };
        }

        return JSON.stringify(data);
    });
}