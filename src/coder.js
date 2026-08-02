import { generateResponse } from './llm.js';
import { storeMessage } from './database.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CODING_SYSTEM_PROMPT = `You are an expert full-stack developer. You write production-quality, multi-file, multi-folder projects.

## Rules:
1. Output ONLY code files. Each file must be prefixed with a special header:
   \`\`\`file: path/to/file.ext
   <file content>
   \`\`\`

2. Create ALL necessary files — package.json, configs, source files, styles, everything.
3. NO emoji icons anywhere. Use SVG icons, icon libraries (lucide-react, heroicons), or text instead.
4. Professional design — modern, clean, production-grade UI. Use Tailwind CSS or proper CSS.
5. Code must be complete and working. No placeholders, no "TODO", no "add your code here".
6. Full-stack: frontend + backend + database if needed.
7. Use best practices: proper folder structure, separation of concerns, error handling.
8. For web apps: use Next.js, React, Vue, or similar modern frameworks.
9. All imports must be correct. All paths must be consistent.
10. Do NOT include node_modules or .git in output.
11. Make sure the project runs with simple "npm install && npm run dev" or similar.

Output format (STRICTLY follow this):
\`\`\`file: package.json
{...}
\`\`\`

\`\`\`file: src/index.js
{...}
\`\`\`

Continue for every file. Do not add explanations between files. Just files.`;

/**
 * Parse the LLM response and extract files
 */
function parseFiles(response) {
  const files = [];
  const regex = /```file:\s*([^\n]+)\n([\s\S]*?)```/g;
  let match;

  while ((match = regex.exec(response)) !== null) {
    const filePath = match[1].trim();
    const content = match[2].trimEnd();
    files.push({ path: filePath, content });
  }

  return files;
}

/**
 * Create a zip file from parsed files
 */
function createProjectZip(files, projectName) {
  const tmpDir = path.join(os.tmpdir(), `gahmood-${Date.now()}`);
  const projectDir = path.join(tmpDir, projectName);
  fs.mkdirSync(projectDir, { recursive: true });

  // Write all files
  for (const file of files) {
    const fullPath = path.join(projectDir, file.path);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(fullPath, file.content, 'utf-8');
  }

  // Create zip
  const zipPath = path.join(tmpDir, `${projectName}.zip`);
  try {
    execSync(`cd "${projectDir}" && tar -acf "${zipPath}" .`, { stdio: 'pipe' });
  } catch (e) {
    // Fallback: try PowerShell Compress-Archive (Windows)
    try {
      execSync(`powershell -Command "Compress-Archive -Path '${projectDir}\\*' -DestinationPath '${zipPath}' -Force"`, { stdio: 'pipe' });
    } catch (e2) {
      console.error('[Code] Zip creation failed:', e2.message);
      return null;
    }
  }

  return { zipPath, projectDir, fileCount: files.length };
}

/**
 * Main coding handler
 */
export async function handleCodeRequest({ chat_id, thread_id, prompt, telegram_msg_id, isEdit, previousFiles }) {
  console.log(`[Code] Request: ${prompt.substring(0, 100)}`);

  let fullPrompt = prompt;
  if (isEdit && previousFiles && previousFiles.length > 0) {
    fullPrompt = `Here is the current project files:\n\n`;
    for (const f of previousFiles) {
      fullPrompt += `\nCurrent file: ${f.path}\n\`\`\`\n${f.content}\n\`\`\`\n`;
    }
    fullPrompt += `\n\nNow make these changes: ${prompt}\n\nOutput the COMPLETE updated project with ALL files (not just changed ones).`;
  }

  const response = await generateResponse({
    systemPrompt: CODING_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: fullPrompt }],
    temperature: 0.2,
    maxTokens: 16000,
  });

  if (!response || response.trim().length === 0) {
    return { error: 'AI returned empty response' };
  }

  // Parse files from response
  const files = parseFiles(response);
  console.log(`[Code] Parsed ${files.length} files`);

  if (files.length === 0) {
    return { error: 'No files found in response', rawResponse: response };
  }

  // Generate project name from prompt
  const projectName = prompt
    .replace(/[^a-zA-Z0-9\u0600-\u06FF\s]/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 3)
    .join('-')
    .toLowerCase()
    .substring(0, 30) || 'project';

  // Create zip
  const zipResult = createProjectZip(files, projectName);
  if (!zipResult) {
    return { error: 'Failed to create zip file' };
  }

  return {
    zipPath: zipResult.zipPath,
    fileCount: zipResult.fileCount,
    files, // For storage/editing later
    projectName,
  };
}
