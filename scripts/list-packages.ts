// scripts/list-packages.ts
// Temporary script: list all installed packages on Xbox via Device Portal
import { DevicePortalClient, XboxPackage } from "../src/xbox/device-portal";

async function main(): Promise<void> {
  const client = new DevicePortalClient({
    xboxIp: "192.168.100.27",
    username: "",
    password: "",
  });

  const alive = await client.ping();
  console.log("Device Portal reachable:", alive);
  if (!alive) { console.error("Cannot reach Xbox Device Portal"); process.exit(1); }

  const pkgs: XboxPackage[] = await client.getInstalledPackages();
  console.log("Total packages installed:", pkgs.length);

  // Search for Dead Island
  const di = pkgs.filter((p: XboxPackage) =>
    p.Name.toLowerCase().includes("dead") ||
    p.Name.toLowerCase().includes("island") ||
    p.PackageFullName.toLowerCase().includes("dead") ||
    p.PackageFullName.toLowerCase().includes("island")
  );

  if (di.length > 0) {
    console.log("\n=== Dead Island packages ===");
    di.forEach((p: XboxPackage) => {
      console.log(`  Name : ${p.Name}`);
      console.log(`  PFN  : ${p.PackageFullName}`);
      console.log(`  PFam : ${p.PackageFamilyName}`);
      console.log();
    });
  } else {
    console.log("\nNo Dead Island package found by name. Listing ALL packages:");
    pkgs.forEach((p: XboxPackage) =>
      console.log(`  [${p.Name}] → ${p.PackageFullName}`)
    );
  }
}

main().catch((e: Error) => { console.error("Error:", e.message); process.exit(1); });
