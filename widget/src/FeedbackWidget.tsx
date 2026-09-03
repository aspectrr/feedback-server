import { createSignal, For, Show } from "solid-js";
import { Dialog } from "@kobalte/core/dialog";
import { capturePage } from "./capture";

export type FeedbackWidgetProps = {
  /** Slug identifying the site; stored as `source` on the feedback server. */
  source: string;
  /** Feedback server base URL. Defaults to the Fly prod host. */
  server?: string;
  /** Optional agent identifier forwarded as `agent_id`. */
  agentId?: string;
  /** Trigger button text. Default "Feedback". */
  label?: string;
};

/**
 * Floating feedback button + modal for Solid sites. Rate 1-5, describe the
 * issue, optionally attach a screenshot of the current page, submit to the
 * aspectrr-feedback server. Styled with hardcoded zinc Tailwind classes so it
 * looks right without a shadcn theme; hosts must Tailwind-scan this package
 * (see README).
 */
export function FeedbackWidget(props: FeedbackWidgetProps) {
  const base = () => (props.server ?? "https://aspectrr-feedback.fly.dev").replace(/\/$/, "");
  const [open, setOpen] = createSignal(false);
  const [message, setMessage] = createSignal("");
  const [rating, setRating] = createSignal(0);
  const [hovered, setHovered] = createSignal(0);
  const [shot, setShot] = createSignal<string | null>(null);
  const [shotMime, setShotMime] = createSignal("image/png");
  const [phase, setPhase] = createSignal<"idle" | "capturing" | "sending">("idle");
  const [error, setError] = createSignal<string | null>(null);
  const [done, setDone] = createSignal(false);

  const reset = () => {
    setMessage("");
    setRating(0);
    setShot(null);
    setError(null);
  };

  const attach = async () => {
    if (phase() !== "idle") return;
    setPhase("capturing");
    setError(null);
    try {
      const [dataUrl, mime] = await capturePage();
      setShot(dataUrl);
      setShotMime(mime);
    } catch {
      setError("Could not capture the page — try again or submit without a screenshot.");
    } finally {
      setPhase("idle");
    }
  };

  const submit = async () => {
    const msg = message().trim();
    if (!msg || phase() !== "idle") return;
    setPhase("sending");
    setError(null);
    try {
      const tokenRes = await fetch(`${base()}/token`, { method: "POST" });
      if (!tokenRes.ok) throw new Error(`token request failed (${tokenRes.status})`);
      const { token } = (await tokenRes.json()) as { token: string };

      const body: Record<string, unknown> = { source: props.source, message: msg };
      if (rating()) body.rating = rating();
      if (props.agentId) body.agent_id = props.agentId;
      if (shot()) {
        body.screenshot = shot()!.split(",")[1];
        body.screenshot_mime = shotMime();
      }

      const res = await fetch(`${base()}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-feedback-token": token },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`submit failed (${res.status})`);

      setOpen(false);
      reset();
      setDone(true);
      setTimeout(() => setDone(false), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setPhase("idle");
    }
  };

  return (
    <>
      <button
        type="button"
        data-feedback-widget
        onClick={() => setOpen(true)}
        class="fixed bottom-4 right-4 z-50 rounded-full bg-zinc-900 px-4 py-2 text-sm font-medium text-white shadow-lg transition-colors hover:bg-zinc-700"
      >
        {props.label ?? "Feedback"}
      </button>

      <Show when={done()}>
        <div class="fixed bottom-20 right-4 z-50 rounded-md bg-zinc-900 px-3 py-2 text-sm text-white shadow-lg">
          Thanks! Feedback sent.
        </div>
      </Show>

      <Dialog open={open()} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay class="fixed inset-0 z-50 bg-black/50" />
          <Dialog.Content
            data-feedback-widget
            class="fixed left-1/2 top-1/2 z-50 w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-zinc-200 bg-white p-4 shadow-xl focus:outline-none"
          >
            <Dialog.Title class="text-sm font-semibold text-zinc-900">Send feedback</Dialog.Title>
            <Dialog.CloseButton
              aria-label="Close"
              class="absolute right-3 top-3 text-lg leading-none text-zinc-400 hover:text-zinc-600"
            >
              ×
            </Dialog.CloseButton>

            <textarea
              ref={(el) => setTimeout(() => el.focus())}
              value={message()}
              onInput={(e) => setMessage(e.currentTarget.value)}
              placeholder="What happened? What did you expect?"
              rows={4}
              class="mt-3 w-full resize-none rounded-md border border-zinc-300 p-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-900/20"
            />

            <div class="mt-2 flex items-center gap-3">
              <div class="flex" onMouseLeave={() => setHovered(0)}>
                <For each={[1, 2, 3, 4, 5]}>
                  {(i) => (
                    <button
                      type="button"
                      aria-label={`Rate ${i} of 5`}
                      onMouseEnter={() => setHovered(i)}
                      onClick={() => setRating(rating() === i ? 0 : i)}
                      class={`px-0.5 text-xl leading-none transition-colors ${
                        (hovered() || rating()) >= i ? "text-amber-400" : "text-zinc-300"
                      }`}
                    >
                      ★
                    </button>
                  )}
                </For>
              </div>

              <Show
                when={shot()}
                fallback={
                  <button
                    type="button"
                    onClick={attach}
                    disabled={phase() === "capturing"}
                    class="ml-auto text-xs text-zinc-500 underline hover:text-zinc-800 disabled:opacity-50"
                  >
                    {phase() === "capturing" ? "Capturing…" : "Attach screenshot"}
                  </button>
                }
              >
                <div class="relative ml-auto">
                  <img
                    src={shot()!}
                    alt="Screenshot preview"
                    class="max-h-24 rounded-md border border-zinc-200"
                  />
                  <button
                    type="button"
                    aria-label="Remove screenshot"
                    onClick={() => setShot(null)}
                    class="absolute -right-2 -top-2 h-5 w-5 rounded-full bg-zinc-900 text-xs leading-none text-white"
                  >
                    ×
                  </button>
                </div>
              </Show>
            </div>

            <Show when={error()}>
              <p class="mt-2 text-xs text-red-600">{error()}</p>
            </Show>

            <button
              type="button"
              onClick={submit}
              disabled={!message().trim() || phase() !== "idle"}
              class="mt-3 w-full rounded-md bg-zinc-900 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50"
            >
              {phase() === "sending" ? "Sending…" : "Send"}
            </button>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>
    </>
  );
}
