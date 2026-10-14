/**
 * The local API server (Settings › Local API server) as another program on this computer uses it: turn it on, create a
 * token in the app, then list the model, search the library, ask (as JSON and streamed) over HTTP; no token or a
 * revoked one gets 401.
 */
import { expect, test } from "@playwright/test";
import { completeSetup, launch, modelsMissing, openDrawerItem, rmUserData, SKIP_REASON, tempUserData } from "./helpers";

test.skip(modelsMissing, SKIP_REASON);

const PORT = 42000 + Math.floor(Math.random() * 2000);

test("a token created in the app lets a program search and ask over HTTP", async () => {
  const userData = tempUserData();
  const s = await launch(userData);
  const { page } = s;
  try {
    await completeSetup(page, userData);
    await openDrawerItem(page, "Settings");
    await page.getByText("Local API server", { exact: true }).first().click();
    await page.getByLabel("Port").fill(String(PORT));
    await page.getByLabel("Port").blur();
    await page.getByRole("switch", { name: "Local API server" }).click();
    await expect(page.getByText(`Running at http://127.0.0.1:${PORT}`)).toBeVisible();

    await page.getByLabel("Token name (e.g. My script)").fill("e2e");
    await page.getByText("＋ Create token").click();
    const token = (await page.getByText(/^boar_[A-Za-z0-9_-]{43}$/).textContent())!;
    expect(token).toMatch(/^boar_/);

    const base = `http://127.0.0.1:${PORT}`;
    const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    expect((await fetch(`${base}/v1/models`)).status).toBe(401);

    const models = await (await fetch(`${base}/v1/models`, { headers: auth })).json();
    expect(models.data[0].id).toMatch(/qwen/i);

    const search = await (await fetch(`${base}/v1/library/search`, { method: "POST", headers: auth, body: JSON.stringify({ query: "What is a black hole?", k: 3 }) })).json();
    expect(search.data[0].title).toBe("Black hole");

    const body = { messages: [{ role: "user", content: "What is a black hole?" }] };
    const done = await (await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: auth, body: JSON.stringify(body) })).json();
    expect(done.choices[0].message.content.toLowerCase()).toContain("black hole");
    expect(done.boar_sources.map((x: { title: string }) => x.title)).toContain("Black hole");

    const sse = await (await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: auth, body: JSON.stringify({ ...body, stream: true }) })).text();
    const events = sse.split("\n\n").filter(Boolean).map((e) => e.replace(/^data: /, ""));
    expect(events.at(-1)).toBe("[DONE]");
    const streamed = events.slice(0, -1).map((e) => JSON.parse(e).choices?.[0]?.delta?.content ?? "").join("");
    expect(streamed.toLowerCase()).toContain("black hole");

    await page.getByText("Revoke", { exact: true }).click();
    await expect(page.getByText("No tokens yet. Programs can't use the server without one.")).toBeVisible();
    expect((await fetch(`${base}/v1/models`, { headers: auth })).status).toBe(401);
    expect(s.errors).toEqual([]);
  } finally {
    await s.app.close();
    rmUserData(userData);
  }
});
