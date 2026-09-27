export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { configureHttpDispatcher } = await import("@/lib/http-dispatcher");
    configureHttpDispatcher();
  }
}
