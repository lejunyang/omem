import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { rootCertificates } from "node:tls";
import { promisify } from "node:util";
import { isIP } from "node:net";
import { hostMatches } from "./operation-policy.ts";

const execute = promisify(execFile);
async function openssl(args: string[], cwd: string) {
  try { await execute("openssl", args, { cwd, timeout: 10000, windowsHide: true }); }
  catch { throw new Error("出网解密不可用，请检查 openssl 和本机密钥目录"); }
}
export const rootDir = (home: string) => join(home, "secrets", "egress-ca");

async function ensureRoot(home: string) {
  const dir = rootDir(home);
  try { await access(join(dir, "root.pem")); return; } catch { }
  const secrets = join(home, "secrets");
  await mkdir(secrets, { recursive: true, mode: 0o700 });
  const tmp = await mkdtemp(join(secrets, "ca-"));
  try {
    await openssl(["req", "-x509", "-newkey", "rsa:3072", "-nodes", "-subj", "/CN=omem sandbox egress", "-days", "3650", "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0", "-addext", "keyUsage=critical,keyCertSign", "-keyout", "key.pem", "-out", "root.pem"], tmp);
    try { await rename(tmp, dir); }
    catch { await access(join(dir, "root.pem")); } // Another process published a complete pair.
  } finally { await rm(tmp, { recursive: true, force: true }); }
}

export async function inspection(home: string, dir: string, patterns: string[]) {
  await openssl(["version"], home);
  await ensureRoot(home);
  const root = rootDir(home);
  const bundle = join(dir, "bundle.pem");
  let roots: string = rootCertificates.join("\n");
  for (const file of [process.env.SSL_CERT_FILE, "/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt"]) {
    if (file) try { roots += "\n" + await readFile(file, "utf8"); break; } catch { }
  }
  await writeFile(bundle, roots + "\n" + await readFile(join(root, "root.pem"), "utf8"), { mode: 0o600 });
  const certs = new Map<string, ReturnType<typeof issue>>();
  async function issue(host: string) {
    const leaf = await mkdtemp(join(root, "leaf-"));
    try {
      await openssl(["req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-subj", "/CN=omem inspected host", "-keyout", "key", "-out", "request"], leaf);
      await writeFile(join(leaf, "extensions"), "basicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\nsubjectAltName=" + (isIP(host) ? "IP:" : "DNS:") + host + "\n");
      await openssl(["x509", "-req", "-in", "request", "-CA", join(root, "root.pem"), "-CAkey", join(root, "key.pem"), "-set_serial", "0x" + randomBytes(16).toString("hex"), "-days", "2", "-extfile", "extensions", "-out", "cert"], leaf);
      return { key: await readFile(join(leaf, "key")), cert: await readFile(join(leaf, "cert")) };
    } finally { await rm(leaf, { recursive: true, force: true }); }
  }
  return {
    bundle, inspect(host: string) {
      if (!patterns.some(p => hostMatches(p, host))) return Promise.resolve(undefined);
      if (!/^[a-z0-9.-]{1,253}$/i.test(host)) throw new Error("解密域名无效");
      let cert = certs.get(host);
      if (!cert) {
        if (certs.size >= 64) throw new Error("本次运行的解密域名已达上限");
        cert = issue(host);
        certs.set(host, cert);
      }
      return cert;
    }
  };
}
