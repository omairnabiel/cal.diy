"use server";

import { revalidatePath } from "next/cache";

/**
 * Server action called from the API keys create/edit/delete client
 * mutations. With the page set to `dynamic = "force-dynamic"` this is
 * mostly redundant — every page render is fresh anyway — but kept as
 * a belt-and-braces hint so any React-Query-driven router navigation
 * picks up the change without a manual hard refresh.
 *
 * Previously called `revalidateTag("viewer.apiKeys.list", "max")` which
 * combined two bugs: (1) the second arg isn't a valid revalidateTag
 * parameter, and (2) the page used `unstable_cache` for per-user
 * mutable data, so cache invalidation was racy. Both are fixed in
 * page.tsx by dropping `unstable_cache`. This file is left in place
 * because client components import `revalidateApiKeysList`.
 */
export async function revalidateApiKeysList() {
  revalidatePath("/settings/developer/api-keys");
}
