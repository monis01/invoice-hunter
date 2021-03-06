import fs from "fs-extra";
import path from "path";
import moment, { Moment } from "moment";
import puppeteer, { ElementHandle } from "puppeteer";

import EndesaConfig from "../config/endesa-config";
import { HuntConfig } from "../types/Hunter";
import { extractTextFromElement } from "../utils/page";

type ProcessedRow = { date: Moment; selector: string; rawDate: string };

type Args = {
  reporter: any;
  lastInvoiceDate: Moment;
  config: HuntConfig;
  downloadDir: string;
};

// browser viewport && window size
const width = 1680;
const height = 950;
export class EndesaHunter {
  private rowsToProcess: ProcessedRow[];
  protected browser: puppeteer.Browser;
  private page: puppeteer.Page | undefined;

  private readonly downloadDir: string;

  protected readonly reporter: any;
  protected readonly locale: string;
  protected readonly lastInvoiceDate: Moment;
  protected readonly invoiceDateFormat: string;

  protected readonly routes: typeof EndesaConfig.routes;
  protected readonly rootPath: typeof EndesaConfig.baseRoute;
  protected readonly selectors: typeof EndesaConfig.selectors;
  protected readonly pageLocale: typeof EndesaConfig.locale;
  protected readonly pageDateFormat: typeof EndesaConfig.dateFormat;
  protected readonly pageInvoiceName: typeof EndesaConfig.invoiceName;
  protected readonly pageInvoiceExtension: typeof EndesaConfig.invoiceExtension;
  protected readonly pageCredentials: { username: string; password: string };

  constructor({ config, reporter, downloadDir, lastInvoiceDate }: Args) {
    this.locale = "en";
    this.rowsToProcess = [];

    this.reporter = reporter;
    this.downloadDir = path.join(downloadDir, "/endesa/");

    this.pageCredentials = {
      username: config.username,
      password: config.password,
    };
    this.lastInvoiceDate = lastInvoiceDate;
    this.invoiceDateFormat = config.invoiceNameFormat ?? "DD-MM-YY";

    this.routes = EndesaConfig.routes;
    this.selectors = EndesaConfig.selectors;
    this.rootPath = EndesaConfig.baseRoute;
    this.pageLocale = EndesaConfig.locale;
    this.pageDateFormat = EndesaConfig.dateFormat;
    this.pageInvoiceName = EndesaConfig.invoiceName;
    this.pageInvoiceExtension = EndesaConfig.invoiceExtension;
  }

  async run() {
    await this.init();

    this.print("Running...");

    try {
      this.print("Trying to login...");
      await this.login();
      this.print("Logged in successfully");
    } catch (e) {
      this.print("Failed to login with provided credentials", "error");
      await this.page?.close();
      await this.browser?.close();
      return;
    }

    try {
      this.print("Downloading invoices");
      const count = await this.downloadInvoices();
      if (count.total > 0) {
        this.print(
          `Downloaded ${count.downloaded}/${count.total} invoices`,
          count.total === count.downloaded
            ? "success"
            : count.downloaded == 0
            ? "error"
            : "info"
        );
      } else {
        this.print("No invoices found to download", "warn");
      }
    } catch (e) {
      this.print("Failed to download invoices", "error");
      this.print(e.message, "error");
    }

    await this.page?.close();
    await this.browser?.close();
  }

  private async init() {
    this.print("Initializing...");

    this.browser = await puppeteer.launch({
      headless: true,
      defaultViewport: { width, height },
      ignoreDefaultArgs: ["--enable-automation"],
      args: [`--window-size=${width},${height}`],
    });

    this.page = await this.browser.newPage();
    await this.page.goto(this.rootPath);
  }

  private async login() {
    if (!this.page) {
      this.print("Login called without initializing", "error");
      throw new Error("Missing init call");
    }

    await this.page.goto(this.rootPath + this.routes.login);

    await this.page.type(
      this.selectors.login.username,
      this.pageCredentials.username
    );
    await this.page.type(
      this.selectors.login.password,
      this.pageCredentials.password
    );

    await this.page.click(this.selectors.acceptCookiesButton);
    await this.page.click(this.selectors.login.submitButton);

    await this.page.waitForNavigation({ waitUntil: "networkidle0" });
    await this.page.waitForTimeout(2000);
  }

  private async downloadInvoices(): Promise<{
    total: number;
    downloaded: number;
  }> {
    if (!this.page) {
      throw new Error("Missing init call");
    }

    let downloadedCount = 0;
    await this.navigateToInvoicesPage();

    await this.findAndSetRowsToProcess(
      await this.page.$$(this.selectors.invoices.listItems)
    );

    if (!this.rowsToProcess.length) {
      return { total: 0, downloaded: downloadedCount };
    }

    this.print(`Found ${this.rowsToProcess.length} invoices`);
    this.reporter.printWithFilepath("Saving invoices to", this.downloadDir);
    const tick = this.reporter.progress(this.rowsToProcess.length);

    for (let i = 0; i < this.rowsToProcess.length; i++) {
      const row = this.rowsToProcess[i];
      if (i > 0) {
        // navigate to the invoice page before downloading
        // for the first item we are already on the invoice page
        await this.navigateToInvoicesPage();
      }

      if (i === 0) {
        this.print(this.reporter.seperator, "log");
      }

      try {
        this.print(`Dowloading invoice for ${row.rawDate}`);
        await this.processRowItem(row);
        downloadedCount++;
      } catch (e) {
        this.print(`Failed to download invoice for ${row.rawDate}`, "error");
      }

      tick();

      this.print(this.reporter.seperator, "log");
    }

    return { total: this.rowsToProcess.length, downloaded: downloadedCount };
  }

  private async navigateToInvoicesPage() {
    await this.page?.goto(this.rootPath + this.routes.invoices);
    await this.page?.waitForSelector(this.selectors.invoices.listItems);
  }

  private async findAndSetRowsToProcess(rows: ElementHandle[]): Promise<void> {
    this.rowsToProcess = await this.findRowsToProcess(rows);
  }

  private async findRowsToProcess(
    rows: ElementHandle[]
  ): Promise<ProcessedRow[]> {
    if (!this.page) {
      throw new Error("Page not initialized");
    }

    const result: ProcessedRow[] = [];
    const { listItems: rowsSelector } = this.selectors.invoices;

    for (let i = 0; i < rows.length; i++) {
      const currentRowSelector = `${rowsSelector}:nth-child(${i + 1})`;
      const date = await extractTextFromElement(
        this.page,
        `${currentRowSelector} ${this.selectors.invoices.dateCell}`
      );

      const currentDate = moment(
        date.trim(),
        this.pageDateFormat,
        this.pageLocale
      ).locale("en");

      if (this.lastInvoiceDate.isBefore(currentDate)) {
        result.push({
          selector: currentRowSelector,
          date: currentDate,
          rawDate: date.trim(),
        });
      }
    }

    return result;
  }

  private async processRowItem(row: ProcessedRow) {
    const { actionCell, actionButton } = this.selectors.invoices;

    await this.page?.click(`${row.selector} ${actionCell} ${actionButton}`);
    await this.page?.waitForSelector(this.selectors.invoice.content, {
      visible: true,
    });

    await this.saveInvoice(this.downloadDir, row);
  }

  private async saveInvoice(downloadPath: string, row: ProcessedRow) {
    const newFileName = `${row.date.format(this.invoiceDateFormat)}.${
      this.pageInvoiceExtension
    }`;
    const fileName = `${this.pageInvoiceName}.${this.pageInvoiceExtension}`;

    /** @ts-ignore */
    await this.page?._client.send("Page.setDownloadBehavior", {
      behavior: "allow",
      downloadPath,
    });

    await this.page?.waitForSelector(this.selectors.invoice.downloadButton);
    await this.page?.click(this.selectors.invoice.downloadButton);

    await this.waitUntilFileIsDownloaded(`${downloadPath}/${fileName}`);

    this.print("Invoice saved", "success");

    await fs.rename(
      `${downloadPath}/${fileName}`,
      `${downloadPath}/${newFileName}`
    );

    this.reporter.printWithFilepath(
      "Invoice renamed to",
      newFileName,
      "success"
    );
  }

  private print(
    msg: string,
    type: "info" | "warn" | "error" | "success" | "log" = "info"
  ): void {
    this.reporter[type](msg);
  }

  private async waitUntilFileIsDownloaded(filePath: string): Promise<void> {
    if (await fs.pathExists(filePath)) {
      return;
    }
    await this.page?.waitForTimeout(1000);
    return this.waitUntilFileIsDownloaded(filePath);
  }
}
