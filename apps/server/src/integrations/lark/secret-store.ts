import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

type SecretPayload = { appId: string; clientSecret: string };

function parseKey(value: string) {
  const key = /^[a-f0-9]{64}$/i.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(value, "base64");
  if (key.length !== 32)
    throw Error("OMEM_SECRET_KEY must encode exactly 32 bytes");
  return key;
}

export class EncryptedSecretStore {
  private readonly key: Buffer;

  constructor(
    readonly directory: string,
    key: string | Buffer,
  ) {
    this.key = Buffer.isBuffer(key) ? Buffer.from(key) : parseKey(key);
    if (this.key.length !== 32)
      throw Error("Secret store key must be 32 bytes");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }

  static fromEnvironment(dataDir: string) {
    const directory = join(dataDir, "secrets");
    const configured = process.env.OMEM_SECRET_KEY;
    if (configured) return new EncryptedSecretStore(directory, configured);
    const file = join(directory, "master.key");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!existsSync(file)) {
      if (readdirSync(directory).some((name) => name.endsWith(".json")))
        throw Error(
          "已有飞书加密凭据，请提供原来的 OMEM_SECRET_KEY；不能用新密钥覆盖旧连接。",
        );
      try {
        writeFileSync(file, randomBytes(32).toString("hex") + "\n", {
          mode: 0o600,
          flag: "wx",
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink())
      throw Error("飞书加密密钥必须是个人目录中的普通文件。");
    chmodSync(file, 0o600);
    return new EncryptedSecretStore(
      directory,
      readFileSync(file, "utf8").trim(),
    );
  }

  private path(reference: string) {
    if (!/^lark:[a-f0-9-]{36}$/.test(reference))
      throw Error("INVALID_SECRET_REFERENCE");
    return join(this.directory, reference.slice(5) + ".json");
  }

  private syncDirectory() {
    try {
      const descriptor = openSync(this.directory, "r");
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
    } catch {
      // Directory fsync is not available on every supported OS.
    }
  }

  put(secret: SecretPayload) {
    const reference = `lark:${randomUUID()}`;
    const path = this.path(reference);
    const temporary = join(this.directory, `.secret-${randomUUID()}`);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(secret), "utf8"),
      cipher.final(),
    ]);
    const payload = JSON.stringify({
      version: 1,
      algorithm: "aes-256-gcm",
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: encrypted.toString("base64"),
    });
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
      writeSync(descriptor, payload, undefined, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    this.syncDirectory();
    return reference;
  }

  get(reference: string): SecretPayload {
    const stored = JSON.parse(readFileSync(this.path(reference), "utf8")) as {
      version: number;
      algorithm: string;
      iv: string;
      tag: string;
      ciphertext: string;
    };
    if (stored.version !== 1 || stored.algorithm !== "aes-256-gcm")
      throw Error("UNSUPPORTED_SECRET_FORMAT");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(stored.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(stored.tag, "base64"));
    return JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(stored.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8"),
    ) as SecretPayload;
  }

  remove(reference: string) {
    const path = this.path(reference);
    if (existsSync(path)) {
      unlinkSync(path);
      this.syncDirectory();
    }
  }

  hashPairingCode(code: string) {
    return createHmac("sha256", this.key)
      .update("omem-lark-pairing-v1\0")
      .update(code)
      .digest("hex");
  }
}
