#!/usr/bin/env node

import inquirer from 'inquirer';
import chalk from 'chalk';
import { spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs-extra';
import ora from 'ora';
import fg from 'fast-glob';

/**
 * Core React to SolidJS conversion logic - NO API required!
 */
function convertReactToSolid(code, filePath) {
    let converted = code;
    
    // Remove Next.js directives
    converted = converted.replace(/'use client'\s*\n/g, '');
    converted = converted.replace(/"use client"\s*\n/g, '');
    
    // Remove React imports
    converted = converted.replace(/import React.*from ['"]react['"];?\n?/g, '');
    converted = converted.replace(/import \{ [^}]*\} from ['"]react['"];?\n?/g, '');
    
    // Detect what SolidJS imports we need
    const needsSignal = /useState/.test(converted);
    const needsEffect = /useEffect/.test(converted);
    const needsMemo = /useMemo/.test(converted);
    const needsRef = /useRef/.test(converted);
    const needsOnMount = /useEffect\([^,]*,\s*\[\]\)/.test(converted);
    
    let solidImports = [];
    if (needsSignal) solidImports.push('createSignal');
    if (needsEffect) solidImports.push('createEffect');
    if (needsMemo) solidImports.push('createMemo');
    if (needsOnMount) solidImports.push('onMount');
    if (needsRef) solidImports.push('createSignal'); // Will use signal for refs
    
    if (solidImports.length > 0) {
        const uniqueImports = [...new Set(solidImports)];
        const importStatement = `import { ${uniqueImports.join(', ')} } from 'solid-js';\n`;
        converted = importStatement + converted;
    }
    
    // Convert hooks
    converted = convertHooks(converted);
    
    // Convert JSX attributes
    converted = convertJSXAttributes(converted);
    
    // Convert event handlers
    converted = convertEventHandlers(converted);
    
    // Fix component exports
    converted = convertExports(converted);
    
    // Clean up extra newlines
    converted = converted.replace(/\n\n\n+/g, '\n\n');
    
    return converted;
}

function convertHooks(code) {
    let converted = code;
    
    // useState -> createSignal
    converted = converted.replace(
        /const\s+\[([^,]+),\s*([^]]+?)\]\s*=\s*useState\(([^)]*)\)/g,
        'const [$1, $2] = createSignal($3)'
    );
    
    // useRef -> createSignal (SolidJS doesn't have refs the same way)
    converted = converted.replace(
        /const\s+(\w+)\s*=\s*useRef<([^>]+)>\(([^)]*)\)/g,
        'const [$1, set$1] = createSignal$3'
    );
    converted = converted.replace(
        /const\s+(\w+)\s*=\s*useRef\(([^)]*)\)/g,
        'const [$1, set$1] = createSignal($2)'
    );
    
    // Handle useEffect with empty dependency array -> onMount
    converted = converted.replace(
        /useEffect\(([^}]+}),\s*\[\]\)/g,
        'onMount(() => $1)'
    );
    
    // Handle useEffect with dependencies -> createEffect
    converted = converted.replace(
        /useEffect\(([^}]+}),\s*\[[^\]]*\]\)/g,
        'createEffect(() => $1)'
    );
    
    // Handle useEffect with no dependencies -> createEffect
    converted = converted.replace(/useEffect\(/g, 'createEffect(');
    
    // useMemo -> createMemo
    converted = converted.replace(
        /useMemo\(([^}]+}),\s*\[[^\]]*\]\)/g,
        'createMemo(() => $1)'
    );
    converted = converted.replace(/useMemo\(/g, 'createMemo(');
    
    // Fix ref.current usage -> just use the signal
    converted = converted.replace(/(\w+)\.current/g, '$1()');
    
    return converted;
}

function convertJSXAttributes(code) {
    let converted = code;
    
    // className -> class
    converted = converted.replace(/className=/g, 'class=');
    
    // htmlFor -> for
    converted = converted.replace(/htmlFor=/g, 'for=');
    
    // Convert style objects (basic cases)
    converted = converted.replace(
        /style=\{\{([^}]+)\}\}/g,
        (match, styles) => {
            const solidStyles = styles.replace(/(\w+):/g, '"$1":');
            return `style={${solidStyles}}`;
        }
    );
    
    return converted;
}

function convertEventHandlers(code) {
    let converted = code;
    
    // onClick, onChange, etc. - mostly stay the same in SolidJS
    // But we might need to handle some specific patterns
    
    // Convert controlled input patterns
    converted = converted.replace(
        /value=\{([^}]+)\}\s+onChange=\{([^}]+)\}/g,
        'value={$1()} onInput={$2}'
    );
    
    return converted;
}

function convertExports(code) {
    let converted = code;
    
    // Convert React.FC types
    converted = converted.replace(/React\.FC<[^>]*>/g, 'Component');
    converted = converted.replace(/: FC<[^>]*>/g, '');
    
    // Handle TypeScript function component types
    converted = converted.replace(/: React\.FC/g, '');
    converted = converted.replace(/: FC/g, '');
    
    // Convert export default function to proper SolidJS component
    if (converted.includes('export default function')) {
        // Already good format for SolidJS
    } else if (converted.match(/export default \w+/)) {
        // Handle export default ComponentName pattern
        const match = converted.match(/export default (\w+)/);
        if (match) {
            const componentName = match[1];
            // Make sure the function is properly defined as export default
            converted = converted.replace(
                new RegExp(`function ${componentName}\\(`),
                `export default function ${componentName}(`
            );
            converted = converted.replace(`export default ${componentName}`, '');
        }
    }
    
    return converted;
}

/**
 * Enhanced file discovery with better React project understanding
 */
async function discoverProjectStructure(projectRoot) {
    const structure = {
        components: [],
        hooks: [],
        utils: [],
        pages: [],
        public: null,
        packageJson: null
    };
    
    // Common React project patterns
    const searchPaths = [
        'src/components/**/*.{tsx,jsx,js}',
        'app/components/**/*.{tsx,jsx,js}',
        'components/**/*.{tsx,jsx,js}',
        'src/hooks/**/*.{tsx,jsx,js}',
        'app/hooks/**/*.{tsx,jsx,js}',
        'hooks/**/*.{tsx,jsx,js}',
        'src/utils/**/*.{tsx,jsx,js}',
        'app/utils/**/*.{tsx,jsx,js}',
        'utils/**/*.{tsx,jsx,js}',
        'src/lib/**/*.{tsx,jsx,js}',
        'app/lib/**/*.{tsx,jsx,js}',
        'lib/**/*.{tsx,jsx,js}',
        'src/pages/**/*.{tsx,jsx,js}',
        'app/pages/**/*.{tsx,jsx,js}',
        'pages/**/*.{tsx,jsx,js}'
    ];
    
    for (const pattern of searchPaths) {
        const files = await fg([pattern], { 
            cwd: projectRoot, 
            onlyFiles: true,
            ignore: ['**/*.stories.*', '**/*.test.*', '**/*.spec.*', '**/node_modules/**']
        });
        
        for (const file of files) {
            const category = determineFileCategory(file);
            if (structure[category]) {
                structure[category].push(file);
            }
        }
    }
    
    // Find public directory
    const publicCandidates = ['public', 'app/public', 'src/public'];
    for (const candidate of publicCandidates) {
        const fullPath = path.join(projectRoot, candidate);
        if (await fs.pathExists(fullPath)) {
            structure.public = candidate;
            break;
        }
    }
    
    // Find package.json
    const packagePath = path.join(projectRoot, 'package.json');
    if (await fs.pathExists(packagePath)) {
        structure.packageJson = await fs.readJson(packagePath);
    }
    
    return structure;
}

function determineFileCategory(filePath) {
    if (filePath.includes('/components/') || filePath.includes('\\components\\')) return 'components';
    if (filePath.includes('/hooks/') || filePath.includes('\\hooks\\')) return 'hooks';
    if (filePath.includes('/pages/') || filePath.includes('\\pages\\')) return 'pages';
    if (filePath.includes('/utils/') || filePath.includes('/lib/')) return 'utils';
    return 'components'; // default
}

/**
 * Execute shell command with better error handling
 */
function runCommand(commandString, cwd) {
    console.log(chalk.dim(`$ ${commandString}  (in ${cwd || './'})`));
    const [command, ...args] = commandString.split(' ');

    const result = spawnSync(command, args, {
        stdio: 'inherit',
        shell: true,
        cwd: cwd
    });

    if (result.status !== 0) {
        console.error(chalk.red(`\nCommand failed with exit code ${result.status}: "${commandString}"`));
        throw new Error(`Command failed: ${commandString}`);
    }
}

/**
 * Main migration logic
 */
async function runMigration() {
    console.log(chalk.cyan.bold('🚀 API-Free React to SolidJS Migration Tool 🚀\n'));
    console.log(chalk.green('✨ No API keys required - Pure local transformations!\n'));

    const answers = await inquirer.prompt([
        {
            type: 'input',
            name: 'oldProjectDir',
            message: 'Enter the path to your React project:',
            default: '.',
        },
        {
            type: 'input',
            name: 'newProjectName',
            message: 'Enter name for your new Astro+SolidJS project:',
            default: 'my-astro-solid-project',
        },
        {
            type: 'input',
            name: 'cloudflareProjectName',
            message: 'Cloudflare project name (for wrangler.toml):',
            validate: (input) => input.trim() !== '' || 'Project name required',
        },
    ]);

    const { oldProjectDir, newProjectName, cloudflareProjectName } = answers;
    const initialCwd = process.cwd();
    const oldProjectRoot = path.resolve(initialCwd, oldProjectDir);
    const newProjectRoot = path.join(initialCwd, newProjectName);

    if (!await fs.pathExists(oldProjectRoot)) {
        console.error(chalk.red(`Error: Source directory not found at ${oldProjectRoot}`));
        process.exit(1);
    }

    try {
        // Step 1: Analyze existing project
        console.log(chalk.blue('\n📊 Step 1: Analyzing your React project structure...'));
        const projectStructure = await discoverProjectStructure(oldProjectRoot);
        
        console.log(chalk.green(`✔ Found ${projectStructure.components.length} components`));
        console.log(chalk.green(`✔ Found ${projectStructure.hooks.length} hooks`));
        console.log(chalk.green(`✔ Found ${projectStructure.utils.length} utilities`));
        if (projectStructure.public) {
            console.log(chalk.green(`✔ Found public assets at: ${projectStructure.public}`));
        }

        // Step 2: Create new Astro project
        console.log(chalk.blue('\n🏗️  Step 2: Creating new Astro project...'));
        runCommand(`npm create astro@latest ${newProjectName} -- --template minimal --no-install --skip-houston`, initialCwd);
        
        // Step 3: Install dependencies
        console.log(chalk.blue('\n📦 Step 3: Installing dependencies...'));
        runCommand('npm install', newProjectRoot);
        runCommand('npm install @astrojs/solid-js @astrojs/cloudflare solid-js', newProjectRoot);
        
        // Step 4: Setup configuration files
        console.log(chalk.blue('\n⚙️  Step 4: Setting up configuration...'));
        
        // Create wrangler.toml
        const today = new Date().toISOString().split('T')[0];
        const wranglerContent = `name = "${cloudflareProjectName}"\ncompatibility_date = "${today}"\n\n[pages_build_output]\ndir = "./dist"`;
        await fs.writeFile(path.join(newProjectRoot, 'wrangler.toml'), wranglerContent);
        
        // Create astro.config.mjs
        const astroConfigContent = `import { defineConfig } from 'astro/config';
import solidJs from '@astrojs/solid-js';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  output: 'server',
  adapter: cloudflare({
    platformProxy: { enabled: true },
    mode: 'directory'
  }),
  integrations: [solidJs()],
});`;
        await fs.writeFile(path.join(newProjectRoot, 'astro.config.mjs'), astroConfigContent);
        
        console.log(chalk.green('✔ Configuration files created'));

        // Step 5: Copy and convert files
        console.log(chalk.blue('\n🔄 Step 5: Converting React components to SolidJS...'));
        
        const conversionResults = {
            success: [],
            failed: [],
            skipped: []
        };

        const allFiles = [
            ...projectStructure.components.map(f => ({ file: f, type: 'components' })),
            ...projectStructure.hooks.map(f => ({ file: f, type: 'hooks' })),
            ...projectStructure.utils.map(f => ({ file: f, type: 'utils' }))
        ];

        for (const { file, type } of allFiles) {
            const spinner = ora(`Converting: ${file}`).start();
            
            try {
                const oldFilePath = path.join(oldProjectRoot, file);
                const fileContent = await fs.readFile(oldFilePath, 'utf-8');
                
                // Skip if it doesn't look like a React component
                if (!fileContent.includes('React') && 
                    !fileContent.includes('useState') && 
                    !fileContent.includes('useEffect') && 
                    !fileContent.includes('useRef') &&
                    !fileContent.includes('useMemo') &&
                    !fileContent.includes('\'use client\'') &&
                    !fileContent.includes('"use client"')) {
                    // Just copy as-is
                    const newFilePath = path.join(newProjectRoot, 'src', file);
                    await fs.ensureDir(path.dirname(newFilePath));
                    await fs.copy(oldFilePath, newFilePath);
                    conversionResults.skipped.push(file);
                    spinner.succeed(chalk.yellow(`Copied (no conversion needed): ${file}`));
                    continue;
                }
                
                const convertedCode = convertReactToSolid(fileContent, file);
                
                const newFilePath = path.join(newProjectRoot, 'src', file);
                await fs.ensureDir(path.dirname(newFilePath));
                await fs.writeFile(newFilePath, convertedCode);
                
                conversionResults.success.push(file);
                spinner.succeed(chalk.green(`Converted: ${file}`));
                
            } catch (error) {
                conversionResults.failed.push({ file, error: error.message });
                spinner.fail(chalk.red(`Failed: ${file} - ${error.message}`));
            }
        }

        // Step 6: Copy public assets
        if (projectStructure.public) {
            console.log(chalk.blue('\n📁 Step 6: Copying public assets...'));
            const sourcePublic = path.join(oldProjectRoot, projectStructure.public);
            const targetPublic = path.join(newProjectRoot, 'public');
            await fs.copy(sourcePublic, targetPublic);
            console.log(chalk.green('✔ Public assets copied'));
        }

        // Step 7: Create layout and pages
        console.log(chalk.blue('\n📄 Step 7: Creating Astro pages...'));
        
        // Create base layout
        const layoutContent = `---
interface Props { title: string; }
const { title } = Astro.props;
---
<!doctype html>
<html lang="en">
	<head>
		<meta charset="UTF-8" />
		<meta name="description" content="Migrated Astro + SolidJS App" />
		<meta name="viewport" content="width=device-width, initial-scale=1.0" />
		<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
		<title>{title}</title>
	</head>
	<body>
		<slot />
	</body>
</html>`;
        
        await fs.ensureDir(path.join(newProjectRoot, 'src/layouts'));
        await fs.writeFile(path.join(newProjectRoot, 'src/layouts/Layout.astro'), layoutContent);

        // Create main page
        let mainComponent = 'HelloWorld'; // fallback
        if (conversionResults.success.length > 0) {
            const componentChoices = conversionResults.success
                .filter(f => f.includes('components/'))
                .map(f => f.replace(/^.*components\//, '').replace(/\.(tsx|jsx)$/, ''));
            
            if (componentChoices.length > 0) {
                const { chosenComponent } = await inquirer.prompt([
                    {
                        type: 'list',
                        name: 'chosenComponent',
                        message: 'Choose your main component for the homepage:',
                        choices: componentChoices,
                    }
                ]);
                mainComponent = chosenComponent;
            }
        }

        const indexPageContent = `---
import Layout from '../layouts/Layout.astro';
import MainComponent from '../components/${mainComponent}';
---
<Layout title="Welcome to Your Migrated App">
	<main>
		<MainComponent client:load />
	</main>
</Layout>`;

        await fs.ensureDir(path.join(newProjectRoot, 'src/pages'));
        await fs.writeFile(path.join(newProjectRoot, 'src/pages/index.astro'), indexPageContent);

        // Summary
        console.log(chalk.cyan.bold('\n\n🎉 Migration Complete! 🎉'));
        console.log(chalk.white(`Project created at: ${newProjectRoot}\n`));
        
        console.log(chalk.green(`✅ Successfully converted: ${conversionResults.success.length} files`));
        console.log(chalk.yellow(`⏭️  Skipped (no conversion needed): ${conversionResults.skipped.length} files`));
        console.log(chalk.red(`❌ Failed conversions: ${conversionResults.failed.length} files`));

        if (conversionResults.failed.length > 0) {
            console.log(chalk.red('\nFailed files (review manually):'));
            conversionResults.failed.forEach(({file, error}) => {
                console.log(chalk.red(`  • ${file}: ${error}`));
            });
        }

        console.log(chalk.bold('\n🚀 Next Steps:'));
        console.log(chalk.cyan(`cd ${newProjectName}`));
        console.log(chalk.cyan('npm run dev'));
        console.log(chalk.cyan('npm run build'));
        console.log(chalk.cyan('npx wrangler pages deploy dist'));

    } catch (error) {
        console.error(chalk.red('\n💥 Migration failed:'));
        console.error(chalk.dim(error.stack || error.message));
        process.exit(1);
    }
}

runMigration();