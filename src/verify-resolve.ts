import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { resolveAllowedSources } from "./permissions.js";

// Known admin user from the main project's file_permissions (manage on all).
const ADMIN = "6d8d799a-9663-44f6-b2bc-4ef3bdff79a0";

async function main() {
  // 1. Exercise the real production helper against the main project.
  const mainCfg = {
    supabaseUrl: process.env.SUPABASE_URL!,
    supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  };
  const sources = await resolveAllowedSources(ADMIN, mainCfg);
  console.log(`[main] resolveAllowedSources(admin) → ${sources.length} allowed source paths`);
  for (const s of sources.slice(0, 5)) console.log(`   • ${s}`);

  // 2. Fail-closed check: a random/unknown user gets nothing.
  const none = await resolveAllowedSources("00000000-0000-0000-0000-000000000000", mainCfg);
  console.log(`[main] resolveAllowedSources(unknown user) → ${none.length} (expected 0)`);

  // 3. Pre-flight: does the BOENDE project have a file_permissions table?
  const boendeUrl = process.env.SUPABASE_URL_BOENDE;
  const boendeKey = process.env.SUPABASE_SERVICE_ROLE_KEY_BOENDE;
  if (!boendeUrl || !boendeKey) {
    console.log("[boende] env not set — skipping");
    return;
  }
  const boende = createClient(boendeUrl, boendeKey);
  const { count, error } = await boende
    .from("file_permissions")
    .select("*", { count: "exact", head: true });
  if (error) {
    console.log(`[boende] file_permissions NOT usable: ${error.message}`);
    console.log("          → boende chat will fail closed (deny all) until this table exists + is populated.");
  } else {
    console.log(`[boende] file_permissions exists — ${count ?? 0} row(s).`);
  }
}

main().catch((err) => {
  console.error("verify-resolve failed:", err.message ?? err);
  process.exit(1);
});
