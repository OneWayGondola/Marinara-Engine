import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

async function runningHomeAnimations(page: Page) {
  return page.locator('[data-component="HomeBrowserHub"]').evaluate((home) =>
    home
      .getAnimations({ subtree: true })
      .filter((animation) => animation.playState === "running" && animation.effect?.getTiming().iterations === Infinity)
      .map((animation) => (animation instanceof CSSAnimation ? animation.animationName : "other")),
  );
}

for (const color of ["#a78bfa", "linear-gradient(90deg, #a78bfa, #ec4899, #22d3ee)"]) {
  for (const theme of ["dark", "light"] as const) {
    test(`mobile Accent Pulse keeps idle settings quiet (${color.startsWith("#") ? "solid" : "gradient"}, ${theme})`, async ({
      page,
    }, testInfo) => {
      test.skip(!testInfo.project.name.includes("mobile"), "Touch-screen rendering budget.");
      await seedUIState(page, {
        hasCompletedOnboarding: true,
        rightPanelOpen: false,
        sidebarOpen: false,
        appAccentColor: color,
        appAccentPulseMode: true,
        appAccentRgbMode: false,
        theme,
      });
      await page.addInitScript((appVersion) => {
        localStorage.setItem("marinara:whats-new:seen-version", appVersion);
      }, version);
      // Keep another browser project's synced Appearance choices out of this fixture.
      await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: null } }));
      await page.goto("/");
      await page.locator('[data-tour="panel-settings"]').tap();
      await page.getByRole("tab", { name: "Appearance", exact: true }).tap();
      await expect(page.getByLabel("Accent Pulse", { exact: true })).toBeChecked();
      const root = page.locator("html");
      await expect(root).toHaveAttribute("data-marinara-accent-animation");
      const firstAccent = await root.evaluate((element) => element.style.getPropertyValue("--primary"));
      await expect
        .poll(() => root.evaluate((element) => element.style.getPropertyValue("--primary")))
        .not.toBe(firstAccent);

      // Sample real transition events while idle, rather than asserting a CSS rule's text.
      const rendering = await page.evaluate(async () => {
        const paintTransitions = new Set<string>();
        const onTransition = (event: TransitionEvent) => {
          if (/color|shadow|filter|background/i.test(event.propertyName)) paintTransitions.add(event.propertyName);
        };
        document.addEventListener("transitionrun", onTransition);
        const before = document.documentElement.style.getPropertyValue("--primary");
        try {
          await new Promise((resolve) => setTimeout(resolve, 2_500));
          return {
            paintTransitions: [...paintTransitions],
            before,
            after: document.documentElement.style.getPropertyValue("--primary"),
          };
        } finally {
          document.removeEventListener("transitionrun", onTransition);
        }
      });
      expect(rendering.after).not.toBe(rendering.before);
      expect(rendering.paintTransitions).toEqual([]);
      await expect.poll(() => runningHomeAnimations(page)).toEqual([]);
      await testInfo.attach("idle-appearance.png", { body: await page.screenshot(), contentType: "image/png" });

      // Returning to Home restores its visible ambient effects.
      await page.locator('[data-tour="panel-settings"]').tap();
      await expect.poll(async () => (await runningHomeAnimations(page)).length).toBeGreaterThan(0);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await expect(root).not.toHaveAttribute("data-marinara-accent-animation");
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await expect(root).toHaveAttribute("data-marinara-accent-animation");
    });
  }
}
