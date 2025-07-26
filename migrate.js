#!/usr/bin/env node

import { GoogleGenAI } from "@google/genai";
import inquirer from 'inquirer';
import chalk from 'chalk';
import { spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs-extra';
import ora from 'ora';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SYSTEM_PROMPT_CODE_CONVERSION = `You are an expert code transpiler. Your task is to convert the provided React component code into its equivalent SolidJS code.
- Convert React hooks (useState, useEffect, useContext) to SolidJS signals and effects (createSignal, createEffect, useContext).
- Change the 'className' prop to 'class'.
- Maintain the original file structure and component logic.
- Ensure all imports are updated for SolidJS where necessary (e.g., remove 'import React...').
- Respond ONLY with the raw, transpiled SolidJS code. Do not include any explanation, markdown (like \`\`\`tsx), comments, or extra text. Your entire response should be valid code.`;

/**
 * Executes a shell command in a specified directory and streams its output.
 * Throws an error if the command fails.
 * @param {string} commandString - The full command to execute (e.g., "npm install").
 * @param {string} cwd - The working directory to run the command in.
 */
function runCommand(commandString, cwd) {
    console.log(chalk.dim(`$ ${commandString}  (in ${cwd || './'})`));
    const [command, ...args] = commandString.split(' ');

    const result = spawnSync(command, args, {
        stdio: 'inherit', // Show real-time output
        shell: true,      // Crucial for finding npm/npx and for cross-platform compatibility
        cwd: cwd          // Set the working directory for this command
    });

    if (result.status !== 0) {
        console.error(chalk.red(`\nCommand failed with exit code ${result.status}: "${commandString}"`));
        throw new Error(`Command failed: ${commandString}`);
    }
}


async function convertFileWithGemini(ai, filePath, fileContent) {
    const prompt = `Convert the following React code from \`${filePath}\` to SolidJS:\n\n---\n\n${fileContent}`;
    
    // Safety net for retries
    for (let i = 0; i < 3; i++) {
        try {
            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: prompt,
                config: {
                    systemInstruction: SYSTEM_PROMPT_CODE_CONVERSION,
                    temperature: 0.1,
                }
            });
            let convertedCode = response.text.trim();
            if (convertedCode.startsWith('\`\`\`')) {
                convertedCode = convertedCode.replace(/^\`\`\`(tsx|jsx|js)?\n/, '').replace(/\n\`\`\`$/, '');
            }
            return convertedCode;
        } catch (error) {
            if (i === 2) throw error; // Rethrow after last attempt
            await new Promise(res => setTimeout(res, 1000 * (i + 1))); // Wait before retrying
        }
    }
}

async function runMigration() {
    console.log(chalk.cyan.bold('🚀 Astro/SolidJS Automated Migration Tool 🚀\n'));

    if (!process.env.GEMINI_API_KEY) {
        console.error(chalk.red('Error: GEMINI_API_KEY environment variable not set.'));
        console.log(chalk.yellow('Please set your API key before running the script:'));
        console.log(chalk.white('export GEMINI_API_KEY="your_api_key_here"'));
        process.exit(1);
    }

    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

    const answers = await inquirer.prompt([
        {
            type: 'input',
            name: 'oldProjectDir',
            message: 'Enter the name of the existing project directory to migrate:',
            default: 'anemone-duette-master',
        },
        {
            type: 'input',
            name: 'newProjectName',
            message: 'Enter the name for your new Astro project directory:',
            default: 'anemone-astro-solid',
        },
        {
            type: 'input',
            name: 'cloudflareProjectName',
            message: 'Enter your Cloudflare project name (for wrangler.toml):',
            validate: (input) => input.trim() !== '' || 'Cloudflare project name cannot be empty.',
        },
    ]);

    const { oldProjectDir, newProjectName, cloudflareProjectName } = answers;
    const initialCwd = process.cwd();
    const oldProjectRoot = path.join(initialCwd, oldProjectDir);
    const newProjectRoot = path.join(initialCwd, newProjectName);
    const conflictDir = path.join(newProjectRoot, 'CONFLICTCHECK');

    if (!await fs.pathExists(oldProjectRoot)) {
        console.error(chalk.red(`Error: Source directory not found at ${oldProjectRoot}`));
        process.exit(1);
    }
    
    try {
        console.log(chalk.blue('\nStep 1: Creating new Astro project...'));
        runCommand(`npm create astro@latest ${newProjectName} -- --template minimal --no-install --skip-houston`, initialCwd);
        
        console.log(chalk.blue('\nStep 2: Installing dependencies...'));
        runCommand('npm install', newProjectRoot);
        
        console.log(chalk.blue('\nStep 3: Adding Astro integrations (SolidJS, Cloudflare)...'));
        runCommand('npx astro add solid -y', newProjectRoot);
        runCommand('npx astro add cloudflare -y', newProjectRoot);
        
        console.log(chalk.blue('\nStep 4: Generating wrangler.toml...'));
        const wranglerContent = `name = "${cloudflareProjectName}"\ncompatibility_date = "2024-07-25"\n\n[pages_build_output]\ndir = "./dist"`;
        await fs.writeFile(path.join(newProjectRoot, 'wrangler.toml'), wranglerContent);
        console.log(chalk.green('✔ wrangler.toml generated.'));

        console.log(chalk.blue('\nStep 5: Migrating public assets...'));
        const oldPublicDir = path.join(oldProjectRoot, 'app', 'public');
        if (await fs.pathExists(oldPublicDir)) {
            await fs.copy(oldPublicDir, path.join(newProjectRoot, 'public'));
            console.log(chalk.green('✔ Public assets migrated.'));
        } else {
            console.log(chalk.yellow('! No public directory found to migrate.'));
        }

        console.log(chalk.blue('\nStep 6: Starting automated component conversion...'));
        const sourceDirs = ['app/components', 'app/ui', 'app/hooks', 'app/lib'];
        for (const dir of sourceDirs) {
            const oldDir = path.join(oldProjectRoot, dir);
            if (await fs.pathExists(oldDir)) {
                const files = await fs.readdir(oldDir, { recursive: true });
                for (const file of files) {
                    const oldFilePath = path.join(oldDir, file);
                    if ((file.endsWith('.tsx') || file.endsWith('.jsx')) && (await fs.stat(oldFilePath)).isFile()) {
                        const fileSpinner = ora(`Converting: ${file}`).start();
                        try {
                            const fileContent = await fs.readFile(oldFilePath, 'utf-8');
                            const convertedCode = await convertFileWithGemini(ai, file, fileContent);
                            
                            const newRelativePath = path.join('src', dir.replace('app/', ''), file);
                            const newFilePath = path.join(newProjectRoot, newRelativePath);
                            
                            await fs.ensureDir(path.dirname(newFilePath));
                            await fs.writeFile(newFilePath, convertedCode);
                            fileSpinner.succeed(chalk.green(`Converted: ${file}`));
                        } catch (err) {
                            fileSpinner.fail(chalk.red(`Failed to convert: ${file}`));
                            await fs.ensureDir(conflictDir);
                            await fs.copy(oldFilePath, path.join(conflictDir, path.basename(file)));
                        }
                    }
                }
            }
        }
        
        console.log(chalk.cyan.bold('\n\n🎉 Migration process completed! 🎉'));
        console.log(chalk.white(`Your new Astro/SolidJS project is ready at: ${newProjectRoot}`));
        console.log(chalk.yellow('Some files may have failed conversion and were moved to the CONFLICTCHECK directory for manual review.'));
        console.log(chalk.bold('\nNext Steps:'));
        console.log(chalk.cyan(`1. cd ${newProjectName}`));
        console.log(chalk.cyan('2. npm run dev'));

    } catch (error) {
        console.error(chalk.red('\n✖ A critical error occurred during the migration.'));
        console.error(chalk.dim(error.message || 'The script had to stop.'));
        process.exit(1);
    }
}

runMigration();
