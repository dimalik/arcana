/**
 * Take screenshots of the app for documentation.
 * Run: npx tsx scripts/take-screenshots.ts
 */
import { chromium } from "playwright";
import path from "path";

const BASE = "http://localhost:3000";
const OUT = path.join(process.cwd(), "docs/screenshots");

// Get session cookie from DB
import Database from "better-sqlite3";
const db = new Database(path.join(process.cwd(), "prisma/dev.db"));
const session = db.prepare("SELECT token FROM UserSession ORDER BY createdAt DESC LIMIT 1").get() as { token: string };
if (!session) { console.error("No session found"); process.exit(1); }

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });

  // Set auth cookie
  await context.addCookies([{
    name: "arcana_session",
    value: session.token,
    domain: "localhost",
    path: "/",
  }]);

  const page = await context.newPage();

  // 1. Library view
  console.log("📸 Library...");
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${OUT}/library.png` });

  // 2. Paper detail — pick first paper
  console.log("📸 Paper detail...");
  const firstPaper = db.prepare("SELECT id FROM Paper WHERE userId = (SELECT id FROM User ORDER BY createdAt LIMIT 1) AND summary IS NOT NULL LIMIT 1").get() as { id: string } | undefined;
  if (firstPaper) {
    await page.goto(`${BASE}/papers/${firstPaper.id}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/paper-detail.png` });

    // Click on different tabs if they exist
    const tabs = await page.locator("[role=tab], button:has-text('Key Findings'), button:has-text('Review')").all();
    if (tabs.length > 1) {
      await tabs[1].click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${OUT}/paper-review.png` });
    }
  }

  // 3. Research project list
  console.log("📸 Research list...");
  await page.goto(`${BASE}/research`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${OUT}/research-list.png` });

  // 4. Research dashboard — pick project with most experiments for the current user
  console.log("📸 Research dashboard...");
  // Use the user from the session cookie
  const sessionUser = db.prepare("SELECT us.userId FROM UserSession us ORDER BY us.createdAt DESC LIMIT 1").get() as { userId: string };
  const project = db.prepare(`
    SELECT rp.id FROM ResearchProject rp
    LEFT JOIN ExperimentResult er ON er.projectId = rp.id
    WHERE rp.userId = ?
    GROUP BY rp.id ORDER BY COUNT(er.id) DESC LIMIT 1
  `).get(sessionUser.userId) as { id: string } | undefined;
  if (project) {
    await page.goto(`${BASE}/research/${project.id}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${OUT}/research-dashboard.png` });

    // Click Experiments filter
    const expFilter = page.locator("button:has-text('Experiments')").first();
    if (await expFilter.isVisible()) {
      await expFilter.click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${OUT}/research-experiments.png` });
    }

    // Click Findings filter
    const findingsFilter = page.locator("button:has-text('Findings')").first();
    if (await findingsFilter.isVisible()) {
      await findingsFilter.click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${OUT}/research-findings.png` });
    }

    // Back to All
    const allFilter = page.locator("button:has-text('All')").first();
    if (await allFilter.isVisible()) {
      await allFilter.click();
      await page.waitForTimeout(300);
    }

    // Click Summary tab in right panel
    const summaryTab = page.locator("button:has-text('Summary')").first();
    if (await summaryTab.isVisible()) {
      await summaryTab.click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${OUT}/research-summary-tab.png` });
    }

    // Click Papers tab
    const papersTab = page.locator("button:has-text('Papers')").first();
    if (await papersTab.isVisible()) {
      await papersTab.click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${OUT}/research-papers-tab.png` });
    }

    // Click Figures tab
    const figuresTab = page.locator("button:has-text('Figures')").first();
    if (await figuresTab.isVisible()) {
      await figuresTab.click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${OUT}/research-figures-tab.png` });
    }

    // Click Files tab
    const filesTab = page.locator("button:has-text('Files')").first();
    if (await filesTab.isVisible()) {
      await filesTab.click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${OUT}/research-files-tab.png` });
    }

    // Click Chat tab
    const chatTab = page.locator("button:has-text('Chat')").first();
    if (await chatTab.isVisible()) {
      await chatTab.click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${OUT}/research-chat-tab.png` });
    }

    // Back to Status tab
    const statusTab = page.locator("button:has-text('Status')").first();
    if (await statusTab.isVisible()) {
      await statusTab.click();
      await page.waitForTimeout(300);
    }
  }

  // 5. Settings
  console.log("📸 Settings...");
  await page.goto(`${BASE}/settings`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${OUT}/settings.png` });

  await browser.close();
  console.log("✅ All screenshots saved to docs/screenshots/");
}

main().catch(console.error);
