import { _generateMetadata } from "app/_utils";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import { getServerSession } from "@calcom/features/auth/lib/getServerSession";
import { PrismaApiKeyRepository } from "@calcom/features/api-keys-legacy/api-keys/repositories/PrismaApiKeyRepository";
import { APP_NAME } from "@calcom/lib/constants";

import { buildLegacyRequest } from "@lib/buildLegacyCtx";

import ApiKeysView from "~/settings/developer/api-keys-view";

export const generateMetadata = async () =>
  await _generateMetadata(
    (t) => t("api_keys"),
    (t) => t("create_first_api_key_description", { appName: APP_NAME }),
    undefined,
    undefined,
    "/settings/developer/api-keys"
  );

// Force dynamic rendering. Each user's API key list is per-user mutable
// state — wrapping it in `unstable_cache` (the previous implementation)
// produced stale UI for up to an hour after every create/delete, because
// (a) the cache wasn't reliably invalidated on mutation (the action's
// `revalidateTag("…", "max")` call passes a non-standard second arg)
// and (b) ApiKeysView renders the server prop directly without a
// client-side useQuery, so React-Query invalidations don't update the
// view. One Prisma call per render is cheap for a per-user settings page.
export const dynamic = "force-dynamic";

const Page = async () => {
  const session = await getServerSession({ req: buildLegacyRequest(await headers(), await cookies()) });

  if (!session) {
    redirect("/auth/login?callbackUrl=/settings/developer/api-keys");
  }

  const apiKeyRepository = await PrismaApiKeyRepository.withGlobalPrisma();
  const apiKeys = await apiKeyRepository.findApiKeysFromUserId({ userId: session.user.id });

  return <ApiKeysView apiKeys={apiKeys} />;
};

export default Page;
