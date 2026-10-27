#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

const HELP = [
  "C15 mobile screenshots for Навчальна студія",
  "",
  "Required environment variables:",
  "  PLAYWRIGHT_BASE_URL (default: http://127.0.0.1:5173)",
  "  PLAYWRIGHT_TEACHER_EMAIL, PLAYWRIGHT_TEACHER_PASSWORD",
  "  PLAYWRIGHT_STUDENT_LOGIN (four letters), PLAYWRIGHT_STUDENT_PASSWORD",
  "",
  "Optional:",
  "  PLAYWRIGHT_STUDENT_ASSIGNMENT_TITLE",
  "  PLAYWRIGHT_TEACHER_BANK_TEMPLATE_TITLE",
  "  PLAYWRIGHT_TEACHER_GRADE (default: 3)",
  "  PLAYWRIGHT_CREATE_BIG_BANK=1 (create a synthetic BIG bank)",
  "  PLAYWRIGHT_ALLOW_TEST_DATA_MUTATIONS=1 (required with CREATE_BIG_BANK)",
  "  SCREENSHOT_DIR (default: artifacts/mobile-screenshots)",
  "",
  "Install without changing project manifests:",
  "  npm install --no-save --package-lock=false playwright",
  "  npx playwright install chromium",
].join("\n");

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write(HELP + "\n");
  process.exit(0);
}

const env = process.env;
const baseURL = (env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:5173").replace(/\/$/, "");
const teacherEmail = env.PLAYWRIGHT_TEACHER_EMAIL;
const teacherPassword = env.PLAYWRIGHT_TEACHER_PASSWORD;
const studentLogin = env.PLAYWRIGHT_STUDENT_LOGIN;
const studentPassword = env.PLAYWRIGHT_STUDENT_PASSWORD;
const assignmentTitle = env.PLAYWRIGHT_STUDENT_ASSIGNMENT_TITLE?.trim();
const bankTemplateTitle = env.PLAYWRIGHT_TEACHER_BANK_TEMPLATE_TITLE?.trim();
const teacherGrade = Number(env.PLAYWRIGHT_TEACHER_GRADE || "3");
const createBigBank = env.PLAYWRIGHT_CREATE_BIG_BANK === "1";
const allowMutations = env.PLAYWRIGHT_ALLOW_TEST_DATA_MUTATIONS === "1";
const outputDir = resolve(env.SCREENSHOT_DIR || "artifacts/mobile-screenshots");
const failures = [];
const viewports = [
  { width: 360, height: 640, suffix: "360x640" },
  { width: 390, height: 844, suffix: "390x844" },
];

function requireEnvironment() {
  const missing = [
    ["PLAYWRIGHT_TEACHER_EMAIL", teacherEmail],
    ["PLAYWRIGHT_TEACHER_PASSWORD", teacherPassword],
    ["PLAYWRIGHT_STUDENT_LOGIN", studentLogin],
    ["PLAYWRIGHT_STUDENT_PASSWORD", studentPassword],
  ].filter((entry) => !entry[1]).map((entry) => entry[0]);
  if (missing.length) {
    throw new Error("Missing required environment variables: " + missing.join(", ") + ". See tools/screenshots/README.md.");
  }
  let url;
  try { url = new URL(baseURL); } catch { throw new Error("PLAYWRIGHT_BASE_URL must be an absolute URL."); }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("PLAYWRIGHT_BASE_URL must use http or https.");
  }
  if (!Number.isInteger(teacherGrade) || teacherGrade < 1 || teacherGrade > 11) {
    throw new Error("PLAYWRIGHT_TEACHER_GRADE must be an integer from 1 through 11.");
  }
  if (createBigBank && !allowMutations) {
    throw new Error("Creating a BIG bank writes test data. Set PLAYWRIGHT_ALLOW_TEST_DATA_MUTATIONS=1 too, and only use an isolated staging/test database.");
  }
}

async function main() {
  requireEnvironment();
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    throw new Error("Playwright is not installed. Run npm install --no-save --package-lock=false playwright, then npx playwright install chromium.");
  }

  await mkdir(outputDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    await captureStudentFlow(browser);
    await captureTeacherFlow(browser);
  } finally {
    await browser.close();
  }

  process.stdout.write("Screenshots saved to " + outputDir + "\n");
  if (failures.length) {
    process.stderr.write("C15 acceptance checks failed:\n" + failures.map((item) => "- " + item).join("\n") + "\n");
    process.exitCode = 1;
  } else {
    process.stdout.write("C15 viewport checks passed: no horizontal overflow and keyboard-safe primary action remained visible.\n");
  }
}

async function capture(page, filename) {
  const filePath = resolve(outputDir, filename);
  await page.screenshot({ path: filePath, fullPage: false, animations: "disabled" });
  const dimensions = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const overflow = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body?.scrollWidth ?? 0,
  }));
  if (overflow.document > overflow.viewport + 1 || overflow.body > overflow.viewport + 1) {
    failures.push(filename + ": horizontal overflow (viewport " + overflow.viewport + "px, document " + overflow.document + "px, body " + overflow.body + "px).");
  }
  process.stdout.write("  " + filename + " (" + dimensions.width + "x" + dimensions.height + ")\n");
}

async function setViewportAndCapture(page, viewport, filename) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await capture(page, filename);
}

async function openLogin(page) {
  await page.goto(baseURL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.getByRole("button", { name: "Учень", exact: true }).waitFor({ state: "visible", timeout: 30000 });
}

async function chooseStudentAssignment(page) {
  const rows = page.locator(".student-assignment");
  await rows.first().waitFor({ state: "visible", timeout: 20000 }).catch(() => {});
  const count = await rows.count();
  if (!count) throw new Error("The synthetic student account has no assigned tests. Assign a numeric test before running C15.");

  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    const text = await row.innerText();
    if (assignmentTitle && !text.includes(assignmentTitle)) continue;
    const button = row.getByRole("button", { name: /^(Почати|Продовжити)$/ });
    if (await button.count() && await button.isEnabled()) {
      await button.click();
      await page.locator(".student-question-prompt").waitFor({ state: "visible", timeout: 30000 });
      return;
    }
  }
  if (assignmentTitle) {
    throw new Error("No enabled student assignment matched PLAYWRIGHT_STUDENT_ASSIGNMENT_TITLE=" + assignmentTitle + ".");
  }
  throw new Error("No enabled student assignment found. Set PLAYWRIGHT_STUDENT_ASSIGNMENT_TITLE to a ready numeric test assigned to the synthetic student.");
}

async function getProgress(page) {
  const text = await page.locator(".student-progress span").innerText();
  const match = text.match(/Запитання\s+(\d+)\s+з\s+(\d+)/i);
  if (!match) throw new Error("Could not parse question progress: " + text);
  return { index: Number(match[1]), total: Number(match[2]) };
}

async function captureStudentFlow(browser) {
  const context = await browser.newContext({
    viewport: { width: 360, height: 640 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true,
  });
  try {
    const page = await context.newPage();
    await openLogin(page);
    await page.getByRole("button", { name: "Учень", exact: true }).click();
    await capture(page, "student-login-360x640.png");
    await setViewportAndCapture(page, viewports[1], "student-login-390x844.png");

    await page.locator('.access-form input[type="text"]').fill(studentLogin);
    await page.locator('.access-form input[type="password"]').fill(studentPassword);
    await page.getByRole("button", { name: "Увійти", exact: true }).click();
    await page.locator(".student-content").waitFor({ state: "visible", timeout: 30000 });
    await chooseStudentAssignment(page);

    const numericInput = page.locator(".student-answer-label input").first();
    await numericInput.waitFor({ state: "visible", timeout: 15000 });
    const inputMode = await numericInput.getAttribute("inputmode");
    if (inputMode !== "decimal" && inputMode !== "numeric") {
      throw new Error("Selected assignment's first question is not numeric (inputmode=" + (inputMode ?? "missing") + "). Set PLAYWRIGHT_STUDENT_ASSIGNMENT_TITLE to a numeric test.");
    }

    for (const viewport of viewports) {
      await setViewportAndCapture(page, viewport, "student-question-" + viewport.suffix + ".png");
    }

    for (const viewport of viewports) {
      const keyboardViewport = { width: viewport.width, height: Math.max(240, Math.round(viewport.height / 2)) };
      await page.setViewportSize(keyboardViewport);
      const input = page.locator(".student-answer-label input").first();
      await input.waitFor({ state: "visible", timeout: 5000 });
      const focused = await input.evaluate((element) => document.activeElement === element);
      if (!focused) failures.push("student-question-keyboard-" + viewport.suffix + ".png: numeric answer field did not retain autofocus.");

      const saveNext = page.getByRole("button", { name: "Зберегти й далі", exact: true });
      await capture(page, "student-question-keyboard-" + viewport.suffix + ".png");
      if (!(await saveNext.isVisible().catch(() => false))) {
        failures.push("student-question-keyboard-" + viewport.suffix + ".png: “Зберегти й далі” is not visible with reduced viewport.");
      } else {
        const box = await saveNext.boundingBox();
        if (!box || box.y + box.height > keyboardViewport.height + 1) {
          failures.push("student-question-keyboard-" + viewport.suffix + ".png: “Зберегти й далі” extends below the viewport.");
        }
      }
    }

    await page.setViewportSize({ width: 360, height: 640 });
    await completeNumericAttempt(page);
    const resultCard = page.locator(".student-result-card");
    await resultCard.waitFor({ state: "visible", timeout: 30000 });
    for (const viewport of viewports) {
      await setViewportAndCapture(page, viewport, "student-result-" + viewport.suffix + ".png");
    }
  } finally {
    await context.close();
  }
}

async function completeNumericAttempt(page) {
  for (let step = 0; step < 101; step += 1) {
    if (await page.locator(".student-result-card").isVisible().catch(() => false)) return;
    await page.locator(".student-question-prompt").waitFor({ state: "visible", timeout: 15000 });
    const before = await getProgress(page);
    const input = page.locator(".student-answer-label input").first();
    await input.waitFor({ state: "visible", timeout: 5000 });

    if (await input.isEnabled()) {
      await input.fill("0"); // Synthetic answer; correctness is irrelevant to layout capture.
      await input.press("Enter");
      await page.waitForFunction((previousIndex) => {
        if (document.querySelector(".student-result-card")) return true;
        const text = document.querySelector(".student-progress span")?.textContent ?? "";
        const match = text.match(/Запитання\s+(\d+)\s+з\s+(\d+)/i);
        const nextAction = Array.from(document.querySelectorAll(".student-action-bar button")).some((button) => {
          const label = button.textContent?.trim();
          return !button.disabled && (label === "Далі" || label === "Завершити тест");
        });
        return (match && Number(match[1]) !== previousIndex) || nextAction;
      }, before.index, { timeout: 20000 });
      await page.waitForTimeout(900); // Practice mode auto-advances within 800 ms.
    }

    if (await page.locator(".student-result-card").isVisible().catch(() => false)) return;
    const after = await getProgress(page);
    if (after.index !== before.index) continue;

    if (before.index < before.total) {
      const next = page.getByRole("button", { name: "Далі", exact: true });
      await next.waitFor({ state: "visible", timeout: 10000 });
      await next.click();
      await page.waitForFunction((previousIndex) => {
        const text = document.querySelector(".student-progress span")?.textContent ?? "";
        const match = text.match(/Запитання\s+(\d+)\s+з\s+(\d+)/i);
        return match && Number(match[1]) !== previousIndex;
      }, before.index, { timeout: 15000 });
    } else {
      const finish = page.getByRole("button", { name: "Завершити тест", exact: true });
      await finish.waitFor({ state: "visible", timeout: 10000 });
      await finish.click();
      await page.locator(".student-result-card").waitFor({ state: "visible", timeout: 30000 });
      return;
    }
  }
  throw new Error("Could not finish the synthetic numeric test within 100 questions.");
}

async function signInTeacher(page) {
  await page.goto(baseURL, { waitUntil: "domcontentloaded", timeout: 30000 });
  const email = page.locator('.access-form input[type="email"]');
  await email.waitFor({ state: "visible", timeout: 30000 });
  await email.fill(teacherEmail);
  await page.locator('.access-form input[type="password"]').fill(teacherPassword);
  await page.getByRole("button", { name: "Увійти", exact: true }).click();
  await page.getByRole("link", { name: "Моя бібліотека", exact: true }).waitFor({ state: "visible", timeout: 30000 });
  await page.getByLabel("Фільтр за класом").selectOption(String(teacherGrade));
  const mathematics = page.locator(".subject-card").filter({ hasText: "Математика" }).first();
  if (await mathematics.count()) await mathematics.click();
}

async function findBankRow(page) {
  const rows = page.locator(".template-row");
  const count = await rows.count();
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    if (bankTemplateTitle && !(await row.innerText()).includes(bankTemplateTitle)) continue;
    if (await row.getByRole("button", { name: "Редагувати банк", exact: true }).count()) return row;
  }
  return null;
}

async function captureTeacherFlow(browser) {
  const context = await browser.newContext({
    viewport: { width: 360, height: 640 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true,
  });
  try {
    const page = await context.newPage();
    await signInTeacher(page);
    const bigTrigger = page.getByRole("button", { name: /Створити тест BIG таблиця множення/ });
    await bigTrigger.waitFor({ state: "visible", timeout: 20000 });
    await bigTrigger.click();
    await page.locator(".bank-dialog").waitFor({ state: "visible", timeout: 10000 });
    await capture(page, "teacher-big-dialog-360x640.png");
    await setViewportAndCapture(page, viewports[1], "teacher-big-dialog-390x844.png");
    await page.getByRole("button", { name: "Закрити діалог", exact: true }).click();

    let row = null;
    if (createBigBank) {
      await bigTrigger.click();
      const dialog = page.locator(".bank-dialog");
      const generatedTitle = "E2E C15 BIG " + new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
      await dialog.locator('input[placeholder="BIG таблиця множення"]').fill(generatedTitle);
      await dialog.getByRole("button", { name: "Створити банк", exact: true }).click();
      await dialog.waitFor({ state: "detached", timeout: 30000 });
      row = page.locator(".template-row").filter({ hasText: generatedTitle });
      await row.getByRole("button", { name: "Редагувати банк", exact: true }).waitFor({ state: "visible", timeout: 30000 });
    } else {
      row = await findBankRow(page);
      if (!row) {
        throw new Error("No existing BIG draft with “Редагувати банк” is visible for this teacher/grade. Set PLAYWRIGHT_TEACHER_BANK_TEMPLATE_TITLE, or create a synthetic bank on isolated staging with PLAYWRIGHT_CREATE_BIG_BANK=1 and PLAYWRIGHT_ALLOW_TEST_DATA_MUTATIONS=1.");
      }
    }

    await row.getByRole("button", { name: "Редагувати банк", exact: true }).click();
    await page.locator(".bank-manager").waitFor({ state: "visible", timeout: 10000 });
    await page.waitForFunction(() => !document.body.innerText.includes("Завантажуємо банк запитань…"), null, { timeout: 30000 });
    for (const viewport of viewports) {
      await setViewportAndCapture(page, viewport, "teacher-bank-manager-" + viewport.suffix + ".png");
    }
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  process.stderr.write("C15 screenshot run failed: " + (error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 1;
});
