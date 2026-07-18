import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Docker image (see Dockerfile).
  output: "standalone",
  // Serve under Lithe's gateway path (e.g. /apps/clientfirst). Empty = root
  // (standalone mode). Must match the app's slug in Lithe's registry.
  basePath: process.env.NEXT_PUBLIC_BASE_PATH ?? "",
};

export default nextConfig;
