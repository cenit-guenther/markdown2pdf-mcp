#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  Request,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { randomUUID } from 'crypto';
import { storePdf, retrievePdf } from './pdfStore.js';
const require = createRequire(import.meta.url);
const pkg = require('../package.json');
const hljs = require('highlight.js');
const tmp = require('tmp');
const { Remarkable } = require('remarkable');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

tmp.setGracefulCleanup();

export class MarkdownPdfServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      {
        name: 'markdown2pdf',
        version: pkg.version,
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers(this.server);

    // Set up error handler first to ensure it's available for all operations
    this.server.onerror = (error: Error): never => {
      // Convert all errors to McpError for consistent handling
      const mcpError = new McpError(
        ErrorCode.InternalError,
        `Server error: ${error.message}`,
        {
          details: {
            name: error.name,
            stack: error.stack
          }
        }
      );
      throw mcpError;
    };

    // Handle process termination gracefully
    const handleShutdown = async (signal: string) => {
      try {
        await this.server.close();
      } catch (error) {
        // Convert unknown error to McpError
        const mcpError = new McpError(
          ErrorCode.InternalError,
          `Server shutdown error during ${signal}: ${error instanceof Error ? error.message : String(error)}`,
          {
            details: {
              signal,
              ...(error instanceof Error ? {
                name: error.name,
                stack: error.stack
              } : {})
            }
          }
        );
        // Throw error directly to avoid stdio interference
        throw mcpError;
      } finally {
        // Ensure clean exit after error is handled
        process.exit(0);
      }
    };

    // Set up signal handlers
    process.once('SIGINT', () => handleShutdown('SIGINT').catch(() => process.exit(1)));
    process.once('SIGTERM', () => handleShutdown('SIGTERM').catch(() => process.exit(1)));
  }

  private setupToolHandlers(server: Server) {
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'create_pdf_from_markdown',
          description: 'Convert markdown content to PDF. Supports basic markdown elements like headers, lists, tables, code blocks, blockquotes, images (both local and external URLs), and Mermaid diagrams. Note: Cannot handle LaTeX math equations. Mermaid syntax errors will be displayed directly in the PDF output.',
          inputSchema: {
            type: 'object',
            properties: {
              markdown: {
                type: 'string',
                description: 'Markdown content to convert to PDF',
              },
              outputFilename: {
                type: 'string',
                description: 'Create a filename for the PDF file to be saved (default: "final-output.pdf"). The environmental variable M2P_OUTPUT_DIR sets the output path directory. If directory is not provided, it will default to user\'s HOME directory.'
              },
              paperFormat: {
                type: 'string',
                description: 'Paper format for the PDF (default: letter)',
                enum: ['letter', 'a4', 'a3', 'a5', 'legal', 'tabloid'],
                default: 'letter'
              },
              paperOrientation: {
                type: 'string',
                description: 'Paper orientation for the PDF (default: portrait)',
                enum: ['portrait', 'landscape'],
                default: 'portrait'
              },
              paperBorder: {
                type: 'string',
                description: 'Border margin for the PDF (default: 2cm). Use CSS units (cm, mm, in, px)',
                pattern: '^[0-9]+(\.[0-9]+)?(cm|mm|in|px)$',
                default: '20mm'
              },
              watermark: {
                type: 'string',
                description: 'Optional watermark text (max 15 characters, uppercase), e.g. "DRAFT", "PRELIMINARY", "CONFIDENTIAL", "FOR REVIEW", etc',
                maxLength: 15,
                pattern: '^[A-Z0-9\\s-]+$'
              },
              watermarkScope: {
                type: 'string',
                description: 'Control watermark visibility: "all-pages" repeats on every page, "first-page" displays on the first page only (default: all-pages)',
                enum: ['all-pages', 'first-page'],
                default: 'all-pages'
              },
              showPageNumbers: {
                type: 'boolean',
                description: 'Include page numbers in the PDF footer (default: false)',
                default: false
              }
            },
            required: ['markdown']
          },
        },
      ],
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name !== 'create_pdf_from_markdown') {
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Unknown tool: ${request.params.name}`
        );
      }

      if (!request.params.arguments) {
        throw new McpError(
          ErrorCode.InvalidParams,
          'No arguments provided'
        );
      }

      const args = request.params.arguments as {
        markdown: string;
        outputFilename?: string;
        paperFormat?: string;
        paperOrientation?: string;
        paperBorder?: string;
        watermark?: string;
        watermarkScope?: 'all-pages' | 'first-page';
        showPageNumbers?: boolean;
      };

      const isHttpMode = process.env.MCP_TRANSPORT === 'http';

      // Get output directory: in HTTP mode use a temp dir; in stdio mode use env/path/home
      const outputDir = isHttpMode ? os.tmpdir() : (() => {
        if (process.env.M2P_OUTPUT_DIR) {
          return path.resolve(process.env.M2P_OUTPUT_DIR);
        }

        if (args.outputFilename && typeof args.outputFilename === 'string') {
          const hasExplicitDirectory =
            path.isAbsolute(args.outputFilename) ||
            path.dirname(args.outputFilename) !== '.';

          if (hasExplicitDirectory) {
            return path.dirname(path.resolve(args.outputFilename));
          }
        }

        return path.resolve(os.homedir());
      })();

      // Ensure output directory exists
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      const {
        markdown,
        outputFilename = 'output.pdf',
        paperFormat = 'letter',
        paperOrientation = 'portrait',
        paperBorder = '2cm',
        watermark = '',
        watermarkScope = 'all-pages',
        showPageNumbers = false
      } = args;

      if (typeof markdown !== 'string' || markdown.trim().length === 0) {
        throw new McpError(
          ErrorCode.InvalidParams,
          'Missing required argument: markdown'
        );
      }

      // Calculate content size and validate
      const contentSize = markdown.length;
      const lineCount = markdown.split('\n').length;

      // Hard limit check - prevent extremely large files that will definitely fail
      const MAX_SIZE = 10 * 1024 * 1024; // 10MB
      if (contentSize > MAX_SIZE) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Markdown content too large (${Math.round(contentSize / 1024 / 1024)}MB). Maximum supported size is ${MAX_SIZE / 1024 / 1024}MB. Consider splitting the content into smaller documents.`,
          {
            details: {
              contentSize,
              maxSize: MAX_SIZE,
              lineCount
            }
          }
        );
      }

      // Calculate dynamic timeouts based on content size
      // Base: 60s load, 7s render. Add 1s per 10KB and 1s per 100 lines
      const baseLoadTimeout = 60000;
      const baseRenderDelay = 7000;
      const loadTimeout = Math.min(
        baseLoadTimeout + Math.floor(contentSize / 10000) * 1000,
        300000 // Max 5 minutes
      );
      const renderDelay = Math.min(
        baseRenderDelay + Math.floor(lineCount / 100) * 1000,
        30000 // Max 30 seconds
      );

      if (contentSize > 500000) { // ~500KB
        console.error(`[markdown2pdf] Warning: Large markdown content detected (${Math.round(contentSize / 1024)}KB, ${lineCount} lines). Processing may take longer than usual.`);
        console.error(`[markdown2pdf] Using extended timeouts: load=${loadTimeout/1000}s, render=${renderDelay/1000}s`);
      }

      // Ensure output filename has .pdf extension
      const filename = outputFilename.toLowerCase().endsWith('.pdf')
        ? outputFilename
        : `${outputFilename}.pdf`;

      // Combine output directory with filename
      const outputPath = path.join(outputDir, filename);

      try {
        // Track operation progress through response content
        const progressUpdates: string[] = [];

        progressUpdates.push(`Starting PDF conversion (format: ${paperFormat}, orientation: ${paperOrientation})`);
        progressUpdates.push(`Content size: ${Math.round(contentSize / 1024)}KB (${lineCount} lines)`);
        progressUpdates.push(`Using output path: ${outputPath}`);

        await this.convertToPdf(
          markdown,
          outputPath,
          paperFormat,
          paperOrientation,
          paperBorder,
          watermark,
          watermarkScope,
          showPageNumbers,
          renderDelay,
          loadTimeout
        );

        // Verify file was created
        if (!fs.existsSync(outputPath)) {
          throw new McpError(
            ErrorCode.InternalError,
            'PDF file was not created',
            {
              details: {
                outputPath,
                paperFormat,
                paperOrientation
              }
            }
          );
        }

        // Ensure absolute path is returned
        const absolutePath = path.resolve(outputPath);

        if (isHttpMode) {
          // Read PDF into memory, store ephemerally, return download URL
          const pdfBuffer = await fs.promises.readFile(absolutePath);
          const safeFilename = path.basename(absolutePath);
          const id = storePdf(pdfBuffer, safeFilename);
          await fs.promises.unlink(absolutePath).catch(() => {});
          const baseUrl = process.env.MCP_BASE_URL ??
            `http://localhost:${process.env.MCP_PORT ?? '3000'}`;
          const downloadUrl = `${baseUrl}/pdf/${id}`;
          return {
            content: [
              {
                type: 'text',
                text: `PDF created successfully.\nDownload URL: ${downloadUrl}`
              },
            ],
          };
        }

        progressUpdates.push(`PDF file created successfully at: ${absolutePath}`);
        progressUpdates.push(`File exists: ${fs.existsSync(absolutePath)}`);

        return {
          content: [
            {
              type: 'text',
              text: progressUpdates.join('\n')
            },
          ],
        };
      } catch (error: unknown) {
        if (error instanceof Error) {
          throw new McpError(
            ErrorCode.InternalError,
            `PDF generation failed: ${error.message}`,
            {
              details: {
                name: error.name,
                stack: error.stack,
                outputPath,
                paperFormat,
                paperOrientation
              }
            }
          );
        }
        throw new McpError(
          ErrorCode.InternalError,
          `PDF generation failed: ${String(error)}`
        );
      }
    });
  }

  private getIncrementalPath(basePath: string): string {
    const dir = path.dirname(basePath);
    const ext = path.extname(basePath);
    const name = path.basename(basePath, ext);
    let counter = 1;
    let newPath = basePath;

    while (fs.existsSync(newPath)) {
      newPath = path.join(dir, `${name}-${counter}${ext}`);
      counter++;
    }

    return newPath;
  }

  private async convertToPdf(
    markdown: string,
    outputPath: string,
    paperFormat: string = 'letter',
    paperOrientation: string = 'portrait',
    paperBorder: string = '2cm',
    watermark: string = '',
    watermarkScope: 'all-pages' | 'first-page' = 'all-pages',
    showPageNumbers: boolean = false,
    renderDelay: number = 7000,
    loadTimeout: number = 60000
  ): Promise<void> {
    return new Promise<void>(async (resolve, reject) => {
      try {
        // Ensure output directory exists
        const outputDir = path.dirname(outputPath);
        await fs.promises.mkdir(outputDir, { recursive: true });

        // Get incremental path and ensure absolute
        outputPath = this.getIncrementalPath(outputPath);
        outputPath = path.resolve(outputPath);

        // Setup markdown parser with syntax highlighting
        const mdParser = new Remarkable({
          breaks: true,
          preset: 'default',
          html: true, // Enable HTML tags
          highlight: (str: string, language: string) => {
            if (language && language === 'mermaid') {
              return `<div class="mermaid">${str}</div>`;
            }
            if (language && hljs.getLanguage(language)) {
              try {
                return hljs.highlight(str, { language }).value;
              } catch (err) { }
            }
            try {
              return hljs.highlightAuto(str).value;
            } catch (err) { }
            return '';
          }
        });

        const watermarkClassName =
          watermarkScope === 'first-page'
            ? 'watermark watermark--first-page'
            : 'watermark watermark--all-pages';

        const headerOffset = '12.5mm';
        const showWatermarkAllPages = Boolean(
          watermark && watermarkScope === 'all-pages'
        );

        // Create HTML content
        const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
  <style>
    @page {
      margin: ${paperBorder};
      ${showWatermarkAllPages ? `margin-top: calc(${paperBorder} + ${headerOffset});` : ''}
      size: ${paperFormat} ${paperOrientation};
    }
    ${
      showWatermarkAllPages
        ? `@page:first { margin-top: ${paperBorder}; }`
        : ''
    }
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
    }
    .page {
      position: relative;
      width: ${paperFormat === 'letter' ? '8.5in' : '210mm'};
      height: ${paperFormat === 'letter' ? '11in' : '297mm'};
      margin: 0;
      padding: 20px;
      box-sizing: border-box;
    }
    .content {
      position: relative;
      z-index: 1;
    }
    .watermark {
      left: 0;
      top: 0;
      right: 0;
      bottom: 0;
      display: flex;
      justify-content: center;
      align-items: center;
      font-size: calc(${paperFormat === 'letter' ? '8.5in' : '210mm'} * 0.14);
      color: rgba(0, 0, 0, 0.15);
      font-family: Arial, sans-serif;
      white-space: nowrap;
      pointer-events: none;
      z-index: 0;
      transform: rotate(-45deg);
    }
    .watermark--all-pages { position: fixed; }
    .watermark--first-page { position: absolute; }
  </style>
</head>
<body>
  <div class="page">
    <div id="mermaid-error" style="display: none; color: red;"></div>
    <div class="content">
      ${mdParser.render(markdown)}
    </div>
    ${watermark ? `<div class="${watermarkClassName}" data-scope="${watermarkScope}">${watermark}</div>` : ''}
  </div>
  <script>
    document.addEventListener('DOMContentLoaded', function () {
      mermaid.initialize({ startOnLoad: false });
      try {
        mermaid.run({
          nodes: document.querySelectorAll('.mermaid')
        });
      } catch (e) {
        const errorDiv = document.getElementById('mermaid-error');
        if (errorDiv) {
          errorDiv.style.display = 'block';
          errorDiv.innerText = e.message;
        }
      }
    });
  </script>
</body>
</html>`;

        // Create temporary HTML file
        const tmpFile = await new Promise<{ path: string, fd: number }>((resolve, reject) => {
          tmp.file({ postfix: '.html' }, (err: Error | null, path: string, fd: number) => {
            if (err) reject(err);
            else resolve({ path, fd });
          });
        });

        // Close file descriptor immediately
        fs.closeSync(tmpFile.fd);

        // Write HTML content
        await fs.promises.writeFile(tmpFile.path, html);

        // Import and use Puppeteer renderer
        const renderPDF = (await import('./puppeteer/render.js')).default;
        await renderPDF({
          htmlPath: tmpFile.path,
          pdfPath: outputPath,
          runningsPath: path.resolve(__dirname, 'runnings.js'),
          cssPath: path.resolve(__dirname, 'css', 'pdf.css'),
          highlightCssPath: '',
          paperFormat,
          paperOrientation,
          paperBorder,
          watermarkScope,
          showPageNumbers,
          renderDelay,
          loadTimeout
        });

        resolve();
      } catch (error) {
        reject(new McpError(
          ErrorCode.InternalError,
          `PDF generation failed: ${error instanceof Error ? error.message : String(error)}`,
          {
            details: {
              phase: error instanceof Error && error.message.includes('renderPDF') ? 'renderPDF' : 'setup',
              outputPath,
              paperFormat,
              paperOrientation,
              ...(error instanceof Error ? {
                name: error.name,
                stack: error.stack
              } : {})
            }
          }
        ));
      }
    });
  }

  private transport: StdioServerTransport | null = null;
  private isRunning: boolean = false;

  private createMcpServer(): Server {
    const server = new Server(
      { name: 'markdown2pdf', version: pkg.version },
      { capabilities: { tools: {} } }
    );
    this.setupToolHandlers(server);
    server.onerror = (error: Error): never => {
      throw new McpError(
        ErrorCode.InternalError,
        `Server error: ${error.message}`,
        { details: { name: error.name, stack: error.stack } }
      );
    };
    return server;
  }

  public async runHttp(): Promise<void> {
    const port = parseInt(process.env.MCP_PORT ?? '3000', 10);
    const app = createMcpExpressApp();
    const transports = new Map<string, StreamableHTTPServerTransport | SSEServerTransport>();

    // Streamable HTTP endpoint (protocol version 2025-11-25)
    app.all('/mcp', async (req: any, res: any) => {
      try {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        let transport: StreamableHTTPServerTransport;

        if (sessionId && transports.has(sessionId)) {
          const existing = transports.get(sessionId)!;
          if (!(existing instanceof StreamableHTTPServerTransport)) {
            res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Session uses a different transport protocol' }, id: null });
            return;
          }
          transport = existing;
        } else if (!sessionId && req.method === 'POST' && isInitializeRequest(req.body)) {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid: string) => {
              transports.set(sid, transport);
            },
          });
          transport.onclose = () => {
            if (transport.sessionId) transports.delete(transport.sessionId);
          };
          await this.createMcpServer().connect(transport);
        } else {
          res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: No valid session ID or not an initialization request' }, id: null });
          return;
        }

        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        console.error('[markdown2pdf] Error handling /mcp request:', error);
        if (!res.headersSent) {
          res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
        }
      }
    });

    // Legacy SSE endpoint (protocol version 2024-11-05)
    app.get('/sse', async (req: any, res: any) => {
      try {
        const transport = new SSEServerTransport('/messages', res);
        transports.set(transport.sessionId, transport);
        res.on('close', () => { transports.delete(transport.sessionId); });
        await this.createMcpServer().connect(transport);
      } catch (error) {
        console.error('[markdown2pdf] Error handling /sse request:', error);
      }
    });

    app.post('/messages', async (req: any, res: any) => {
      const sessionId = req.query.sessionId as string;
      const transport = transports.get(sessionId);
      if (transport instanceof SSEServerTransport) {
        await transport.handlePostMessage(req, res, req.body);
      } else {
        res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'No SSE transport found for sessionId' }, id: null });
      }
    });

    // PDF download endpoint
    app.get('/pdf/:id', (req: any, res: any) => {
      const entry = retrievePdf(req.params.id);
      if (!entry) {
        res.status(404).json({ error: 'PDF not found or expired' });
        return;
      }
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${entry.filename}"`);
      res.send(entry.buffer);
    });

    await new Promise<void>((resolve) => {
      const httpServer = app.listen(port, () => {
        console.error(`[markdown2pdf] HTTP server listening on port ${port}`);
        console.error(`[markdown2pdf] StreamableHTTP: POST /mcp | Legacy SSE: GET /sse | Download: GET /pdf/:id`);
      });

      const shutdown = () => { httpServer.close(() => resolve()); };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    });
  }

  public async run(): Promise<void> {
    if (process.env.MCP_TRANSPORT === 'http') {
      return this.runHttp();
    }
    return this.runStdio();
  }

  public async runStdio(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.transport = new StdioServerTransport();

    try {
      await this.server.connect(this.transport);

      // Keep the process running until explicitly closed
      return new Promise<void>((resolve) => {
        const cleanup = async () => {
          this.isRunning = false;
          if (this.transport) {
            try {
              await this.server.close();
            } catch (error) {
              console.error('Error during server shutdown:', error);
            }
            this.transport = null;
          }
          resolve();
        };

        process.once('SIGINT', cleanup);
        process.once('SIGTERM', cleanup);
      });
    } catch (error) {
      this.isRunning = false;
      if (this.transport) {
        try {
          await this.server.close();
        } catch (closeError) {
          console.error('Error during error cleanup:', closeError);
        }
        this.transport = null;
      }
      throw error;
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const server = new MarkdownPdfServer();
  server.run().catch(error => {
    if (error instanceof Error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Server initialization failed: ${error.message}`,
        {
          details: {
            name: error.name,
            stack: error.stack
          }
        }
      );
    }
    throw new McpError(
      ErrorCode.InternalError,
      `Server initialization failed: ${String(error)}`
    );
  });
}
