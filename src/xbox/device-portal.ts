// src/xbox/device-portal.ts
// Xbox Device Portal client — accesses your Xbox Series X over local WiFi.
//
// PREREQUISITES (one-time setup, costs $19 USD):
//   1. Go to https://dev.xbox.com and register as a developer
//   2. On Xbox: Settings → System → Developer settings → Activate Developer Mode
//   3. Note the IP shown and set a username/password in the portal
//
// Then run: npm run sync -- --download --xbox-ip 192.168.1.X --user U --pass P

import * as https from "https";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";

// Dead Island Definitive Edition package family name on Xbox
// (may vary slightly by region — the tool auto-discovers it)
const DI_PACKAGE_NAMES = [
  "DeadIslandDefinitiveEdition",
  "DeadIsland",
  "DIDEFINITIVE",
];

export interface DevicePortalConfig {
  xboxIp: string;
  username: string;
  password: string;
  port?: number; // default 11443
}

export interface XboxPackage {
  Name: string;
  PackageFullName: string;
  PackageFamilyName: string;
  Version: string;
}

export interface FileEntry {
  Name: string;
  Type: "File" | "Folder";
  SizeInBytes?: number;
  CreationTime?: string;
  LastAccessTime?: string;
  LastWriteTime?: string;
}

/**
 * Minimal Xbox Device Portal HTTP client.
 * All communication is over HTTPS with Basic Auth (self-signed cert on Xbox).
 */
export class DevicePortalClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  // Accept self-signed certs from the Xbox
  private readonly agent: https.Agent;

  constructor(config: DevicePortalConfig) {
    const port = config.port ?? 11443;
    this.baseUrl = `https://${config.xboxIp}:${port}`;
    this.authHeader =
      "Basic " +
      Buffer.from(`${config.username}:${config.password}`).toString("base64");
    this.agent = new https.Agent({ rejectUnauthorized: false });
  }

  // ── Low-level request ─────────────────────────────────────────────────────

  private request(
    method: "GET" | "POST" | "DELETE",
    urlPath: string,
    params?: Record<string, string>
  ): Promise<{ statusCode: number; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const query = params
        ? "?" + new URLSearchParams(params).toString()
        : "";
      const fullUrl = `${this.baseUrl}${urlPath}${query}`;
      const url = new URL(fullUrl);

      const options: https.RequestOptions = {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname + url.search,
        method,
        headers: {
          Authorization: this.authHeader,
          Accept: "application/json",
        },
        agent: this.agent,
      };

      const req = https.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks) })
        );
      });

      req.on("error", reject);
      req.end();
    });
  }

  private async getJson<T>(urlPath: string, params?: Record<string, string>): Promise<T> {
    const { statusCode, body } = await this.request("GET", urlPath, params);
    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(
        `Xbox Device Portal returned HTTP ${statusCode} for ${urlPath}: ${body.toString("utf8").slice(0, 200)}`
      );
    }
    return JSON.parse(body.toString("utf8")) as T;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Get list of installed packages (games and apps).
   */
  async getInstalledPackages(): Promise<XboxPackage[]> {
    const data = await this.getJson<{ InstalledPackages: XboxPackage[] }>(
      "/api/app/packagemanager/packages"
    );
    return data.InstalledPackages ?? [];
  }

  /**
   * Find the Dead Island DE package by matching known name fragments.
   */
  async findDeadIslandPackage(): Promise<XboxPackage | null> {
    const packages = await this.getInstalledPackages();
    for (const pkg of packages) {
      for (const name of DI_PACKAGE_NAMES) {
        if (
          pkg.Name.toLowerCase().includes(name.toLowerCase()) ||
          pkg.PackageFullName.toLowerCase().includes(name.toLowerCase()) ||
          pkg.PackageFamilyName.toLowerCase().includes(name.toLowerCase())
        ) {
          return pkg;
        }
      }
    }
    return null;
  }

  /**
   * List files in a known folder for a given package.
   * knownFolderIds: "LocalAppData", "RoamingAppData", "ProgramFiles", etc.
   */
  async listFiles(
    packageFullName: string,
    knownFolderId: string = "LocalAppData",
    subPath: string = "\\"
  ): Promise<FileEntry[]> {
    const data = await this.getJson<{ Items: FileEntry[] }>(
      "/api/filesystem/apps/files",
      {
        knownfolderid: knownFolderId,
        packagefullname: packageFullName,
        path: subPath,
      }
    );
    return data.Items ?? [];
  }

  /**
   * Download a file from the Xbox and save it locally.
   * Returns the number of bytes written.
   */
  async downloadFile(
    packageFullName: string,
    remoteFilename: string,
    localOutputPath: string,
    knownFolderId: string = "LocalAppData"
  ): Promise<number> {
    const { statusCode, body } = await this.request("GET", "/api/filesystem/apps/file", {
      knownfolderid: knownFolderId,
      packagefullname: packageFullName,
      filename: remoteFilename,
    });

    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(
        `Failed to download file: HTTP ${statusCode}. Body: ${body.toString("utf8").slice(0, 200)}`
      );
    }

    fs.mkdirSync(path.dirname(localOutputPath), { recursive: true });
    fs.writeFileSync(localOutputPath, body);
    return body.length;
  }

  /**
   * Upload (inject) a file to the Xbox.
   * Uses multipart/form-data POST.
   */
  async uploadFile(
    packageFullName: string,
    remoteFilename: string,
    localFilePath: string,
    knownFolderId: string = "LocalAppData"
  ): Promise<void> {
    const fileData = fs.readFileSync(localFilePath);
    const fileName = path.basename(remoteFilename);

    const boundary = "----XboxSaveEditorBoundary" + Date.now().toString(16);
    const CRLF = "\r\n";

    const bodyParts: Buffer[] = [
      Buffer.from(
        `--${boundary}${CRLF}` +
          `Content-Disposition: form-data; name="file-to-upload"; filename="${fileName}"${CRLF}` +
          `Content-Type: application/octet-stream${CRLF}${CRLF}`
      ),
      fileData,
      Buffer.from(`${CRLF}--${boundary}--${CRLF}`),
    ];
    const body = Buffer.concat(bodyParts);

    const query = new URLSearchParams({
      knownfolderid: knownFolderId,
      packagefullname: packageFullName,
      filename: remoteFilename,
    });

    await new Promise<void>((resolve, reject) => {
      const url = new URL(`${this.baseUrl}/api/filesystem/apps/file?${query}`);
      const options: https.RequestOptions = {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          Authorization: this.authHeader,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length,
        },
        agent: this.agent,
      };

      const req = https.request(options, (res) => {
        res.resume(); // drain
        res.on("end", () => {
          if ((res.statusCode ?? 0) >= 400) {
            reject(new Error(`Upload failed: HTTP ${res.statusCode}`));
          } else {
            resolve();
          }
        });
      });

      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }

  /**
   * Quick connectivity test — returns true if Device Portal is reachable.
   */
  async ping(): Promise<boolean> {
    try {
      const { statusCode } = await this.request("GET", "/api/os/info");
      return statusCode === 200;
    } catch {
      return false;
    }
  }

  /**
   * Get Xbox OS info.
   */
  async getOsInfo(): Promise<Record<string, unknown>> {
    return this.getJson("/api/os/info");
  }
}
