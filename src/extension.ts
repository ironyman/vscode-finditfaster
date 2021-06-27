/**
 * TODO:
 * [ ] When text is selected, use that to fill the fzf prompt
 * [ ] Show relative paths whenever possible
 *     - This might be tricky. I could figure out the common base path of all dirs we search, I guess?
 *
 * Feature options:
 * [ ] Buffer of open files / show currently open files / always show at bottom => workspace.textDocuments is a bit curious / borked
 */

import { tmpdir } from 'os';
import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import assert = require('assert');
// Let's keep it DRY and load the package here so we can reuse some data from it
let PACKAGE: any;
// Reference to the terminal we use
let term: vscode.Terminal;

//
// Define the commands we expose. URIs are populated upon extension activation
// because only then we'll know the actual paths.
//
interface Command {
    script: string,
    uri: vscode.Uri | undefined,
    preRunCallback: undefined | (() => void),
}
const commands: { [key: string]: Command } = {
    findFiles: {
        script: 'find_files.sh',
        uri: undefined,
        preRunCallback: undefined,
    },
    findWithinFiles: {
        script: 'find_within_files.sh',
        uri: undefined,
        preRunCallback: undefined,
    },
    listSearchLocations: {
        script: 'list_search_locations.sh',
        uri: undefined,
        preRunCallback: writePathOriginsFile,
    },
    flightCheck: {
        script: 'flight_check.sh',
        uri: undefined,
        preRunCallback: undefined,
    }
};

type WhenCondition = 'always' | 'never' | 'noWorkspaceOnly';
enum PathOrigin {
    cwd = 1 << 0,
    workspace = 1 << 1,
    settings = 1 << 2,
}

/** Global variable cesspool erm, I mean, Configuration Data Structure! It does the job for now. */
interface Config {
    extensionName: string | undefined,
    searchPaths: string[],
    searchPathsOrigins: { [key: string]: PathOrigin },
    disableStartupChecks: boolean,
    useEditorSelectionAsQuery: boolean,
    useWorkspaceSearchExcludes: boolean,
    findFilesPreviewEnabled: boolean,
    findFilesPreviewCommand: string,
    findFilesPreviewWindowConfig: string,
    findWithinFilesPreviewEnabled: boolean,
    findWithinFilesPreviewCommand: string,
    findWithinFilesPreviewWindowConfig: string,
    workspaceSettings: {
        folders: string[],
    },
    canaryFile: string,
    selectionFile: string,
    hideTerminalAfterSuccess: boolean,
    hideTerminalAfterFail: boolean,
    clearTerminalAfterUse: boolean,
    showMaximizedTerminal: boolean,
    flightCheckPassed: boolean,
    additionalSearchLocations: string[],
    additionalSearchLocationsWhen: WhenCondition,
    searchCurrentWorkingDirectory: WhenCondition,
    searchWorkspaceFolders: boolean,
    extensionPath: string,
    tempDir: string,
};
const CFG: Config = {
    extensionName: undefined,
    searchPaths: [],
    searchPathsOrigins: {},
    disableStartupChecks: false,
    useEditorSelectionAsQuery: true,
    useWorkspaceSearchExcludes: true,
    findFilesPreviewEnabled: true,
    findFilesPreviewCommand: '',
    findFilesPreviewWindowConfig: '',
    findWithinFilesPreviewEnabled: true,
    findWithinFilesPreviewCommand: '',
    findWithinFilesPreviewWindowConfig: '',
    workspaceSettings: {
        folders: [],
    },
    canaryFile: '',
    selectionFile: '',
    hideTerminalAfterSuccess: false,
    hideTerminalAfterFail: false,
    clearTerminalAfterUse: false,
    showMaximizedTerminal: false,
    flightCheckPassed: false,
    additionalSearchLocations: [],
    additionalSearchLocationsWhen: 'never',
    searchCurrentWorkingDirectory: 'never',
    searchWorkspaceFolders: true,
    extensionPath: '',
    tempDir: '',
};

/** Ensure that whatever command we expose in package.json actually exists */
function checkExposedFunctions() {
    for (const x of PACKAGE.contributes.commands) {
        const fName = x.command.substr(PACKAGE.name.length + '.'.length);
        assert(fName in commands);
    }
}

/** We need the extension context to get paths to our scripts. We do that here. */
function setupConfig(context: vscode.ExtensionContext) {
    CFG.extensionName = PACKAGE.name;
    assert(CFG.extensionName);
    const local = (x: string) => vscode.Uri.file(path.join(context.extensionPath, x));
    commands.findFiles.uri = local(commands.findFiles.script);
    commands.findWithinFiles.uri = local(commands.findWithinFiles.script);
    commands.listSearchLocations.uri = local(commands.listSearchLocations.script);
    commands.flightCheck.uri = local(commands.flightCheck.script);
}

/** Register the commands we defined with VS Code so users have access to them */
function registerCommands() {
    Object.keys(commands).map((k) => {
        vscode.commands.registerCommand(`${CFG.extensionName}.${k}`, () => {
            executeTerminalCommand(k);
        });
    });
}

/** Entry point called by VS Code */
export function activate(context: vscode.ExtensionContext) {
    CFG.extensionPath = context.extensionPath;
    const local = (x: string) => vscode.Uri.file(path.join(CFG.extensionPath, x));

    // Load our package.json
    PACKAGE = JSON.parse(fs.readFileSync(local('package.json').fsPath, 'utf-8'));
    setupConfig(context);
    checkExposedFunctions();

    handleWorkspaceSettingsChanges();
    handleWorkspaceFoldersChanges();

    registerCommands();
    reinitialize();
}

/* Called when extension is deactivated by VS Code */
export function deactivate() {
    term?.dispose();
    fs.rmSync(CFG.canaryFile, { force: true });
    fs.rmSync(CFG.selectionFile, { force: true });
}

/** Map settings from the user-configurable settings to our internal data structure */
function updateConfigWithUserSettings() {
    function getCFG<T>(key: string) {
        const userCfg = vscode.workspace.getConfiguration();
        const ret = userCfg.get<T>(`${CFG.extensionName}.${key}`);
        assert(ret !== undefined);
        return ret;
    }

    CFG.disableStartupChecks = getCFG('advanced.disableStartupChecks');
    CFG.useEditorSelectionAsQuery = getCFG('advanced.useEditorSelectionAsQuery');
    CFG.useWorkspaceSearchExcludes = getCFG('general.useWorkspaceSearchExcludes');
    CFG.additionalSearchLocations = getCFG('general.additionalSearchLocations');
    CFG.additionalSearchLocationsWhen = getCFG('general.additionalSearchLocationsWhen');
    CFG.searchCurrentWorkingDirectory = getCFG('general.searchCurrentWorkingDirectory');
    CFG.searchWorkspaceFolders = getCFG('general.searchWorkspaceFolders');
    CFG.hideTerminalAfterSuccess = getCFG('general.hideTerminalAfterSuccess');
    CFG.hideTerminalAfterFail = getCFG('general.hideTerminalAfterFail');
    CFG.clearTerminalAfterUse = getCFG('general.clearTerminalAfterUse');
    CFG.showMaximizedTerminal = getCFG('general.showMaximizedTerminal');
    CFG.findFilesPreviewEnabled = getCFG('findFiles.showPreview');
    CFG.findFilesPreviewCommand = getCFG('findFiles.previewCommand');
    CFG.findFilesPreviewWindowConfig = getCFG('findFiles.previewWindowConfig');
    CFG.findWithinFilesPreviewEnabled = getCFG('findWithinFiles.showPreview');
    CFG.findWithinFilesPreviewCommand = getCFG('findWithinFiles.previewCommand');
    CFG.findWithinFilesPreviewWindowConfig = getCFG('findWithinFiles.previewWindowConfig');
}

function collectSearchLocations() {
    const locations = [];
    // searchPathsOrigins is for diagnostics only
    CFG.searchPathsOrigins = {};
    const setOrUpdateOrigin = (path: string, origin: PathOrigin) => {
        if (CFG.searchPathsOrigins[path] === undefined) {
            CFG.searchPathsOrigins[path] = origin;
        } else {
            CFG.searchPathsOrigins[path] |= origin;
        }
    };
    // cwd
    const addCwd = () => {
        const cwd = process.cwd();
        locations.push(cwd);
        setOrUpdateOrigin(cwd, PathOrigin.cwd);
    };
    switch (CFG.searchCurrentWorkingDirectory) {
        case 'always':
            addCwd();
            break;
        case 'never':
            break;
        case 'noWorkspaceOnly':
            if (vscode.workspace.workspaceFolders === undefined) {
                addCwd();
            }
            break;
        default:
            assert(false, 'Unhandled case');
    }

    // additional search locations from extension settings
    const addSearchLocationsFromSettings = () => {
        locations.push(...CFG.additionalSearchLocations);
        CFG.additionalSearchLocations.forEach(x => setOrUpdateOrigin(x, PathOrigin.settings));
    };
    switch (CFG.additionalSearchLocationsWhen) {
        case 'always':
            addSearchLocationsFromSettings();
            break;
        case 'never':
            break;
        case 'noWorkspaceOnly':
            if (vscode.workspace.workspaceFolders === undefined) {
                addSearchLocationsFromSettings();
            }
            break;
        default:
            assert(false, 'Unhandled case');
    }

    // add the workspace folders
    if (CFG.searchWorkspaceFolders && vscode.workspace.workspaceFolders !== undefined) {
        const dirs = vscode.workspace.workspaceFolders.map(x => {
            const uri = decodeURI(x.uri.toString());
            if (uri.substr(0, 7) === 'file://') {
                return uri.substr(7);
            } else {
                vscode.window.showErrorMessage('Non-file:// uri\'s not currently supported...');
                return '';
            }
        });
        locations.push(...dirs);
        dirs.forEach(x => setOrUpdateOrigin(x, PathOrigin.workspace));
    }

    return locations;
}

/** Produce a human-readable string explaining where the search paths come from */
function explainSearchLocations(useColor = false) {
    const listDirs = (which: PathOrigin) => {
        let str = '';
        Object.entries(CFG.searchPathsOrigins).forEach(([k, v]) => {
            if ((v & which) !== 0) {
                str += `- ${k}\n`;
            }
        });
        if (str.length === 0) {
            str += '- <none>\n';
        }
        return str;
    };

    const maybeBlue = (s: string) => {
        return useColor ? `\\033[36m${s}\\033[0m` : s;
    };

    let ret = '';
    ret += maybeBlue('Paths added because they\'re the working directory:\n');
    ret += listDirs(PathOrigin.cwd);
    ret += maybeBlue('Paths added because they\'re defined in the workspace:\n');
    ret += listDirs(PathOrigin.workspace);
    ret += maybeBlue('Paths added because they\'re the specified in the settings:\n');
    ret += listDirs(PathOrigin.settings);

    return ret;
}

function writePathOriginsFile() {
    fs.writeFileSync(path.join(CFG.tempDir, 'paths_explain'), explainSearchLocations(true));
    console.log(`wrote to ${path.join(CFG.tempDir, 'paths_explain')}`);
}

function handleWorkspaceFoldersChanges() {

    CFG.searchPaths = collectSearchLocations();

    // Also re-update when anything changes
    vscode.workspace.onDidChangeWorkspaceFolders(event => {
        console.log('workspace folders changed: ', event);
        CFG.searchPaths = collectSearchLocations();
    });
}

function handleWorkspaceSettingsChanges() {
    updateConfigWithUserSettings();

    // Also re-update when anything changes
    vscode.workspace.onDidChangeConfiguration(_ => {
        updateConfigWithUserSettings();
        // This may also have affected our search paths
        CFG.searchPaths = collectSearchLocations();
        // We need to update the env vars in the terminal
        reinitialize();
    });
}

/** Check seat belts are on. Also, check terminal commands are on PATH */
function doFlightCheck(): boolean {
    const parseKeyValue = (line: string) => {
        return line.split(': ', 2);
    };

    // Windows native
    if (os.platform() === 'win32') {
        vscode.window.showErrorMessage('Native Windows support does not exist at this point in time. You can however run inside a Remote-WSL workspace. See the README for more information.');
        return false;
    }

    try {
        let errStr = '';
        const kvs: any = {};
        const out = cp.execFileSync(getCommandString(commands.flightCheck, false, true), { shell: true }).toString('utf-8');
        out.split('\n').map(x => {
            const maybeKV = parseKeyValue(x);
            if (maybeKV.length === 2) {
                kvs[maybeKV[0]] = maybeKV[1];
            }
        });
        if (kvs['which bat'] === undefined || kvs['which bat'] === '') {
            errStr += 'bat not found on your PATH\n. ';
        }
        if (kvs['which fzf'] === undefined || kvs['which fzf'] === '') {
            errStr += 'fzf not found on your PATH\n. ';
        }
        if (kvs['which rg'] === undefined || kvs['which rg'] === '') {
            errStr += 'rg not found on your PATH\n. ';
        }
        if (errStr !== '') {
            vscode.window.showErrorMessage(`Failed to activate plugin: ${errStr}\nMake sure you have the required command line tools installed as outlined in the README.`);
        }

        return errStr === '';
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to run checks before starting extension. Maybe this is helpful: ${error}`);
        return false;
    }
}

/**
 * All the logic that's the same between starting the plugin and re-starting
 * after user settings change
 */
function reinitialize() {

    term?.dispose();
    updateConfigWithUserSettings();
    // console.log('plugin config:', CFG);
    if (!CFG.flightCheckPassed && !CFG.disableStartupChecks) {
        CFG.flightCheckPassed = doFlightCheck();
    }

    if (!CFG.flightCheckPassed && !CFG.disableStartupChecks) {
        return false;
    }

    //
    // Set up a file watcher. Its contents tell us what files the user selected.
    // It also means the command was completed so we can do stuff like
    // optionally hiding the terminal.
    //
    CFG.tempDir = fs.mkdtempSync(`${tmpdir()}${path.sep}${CFG.extensionName}-`);
    CFG.canaryFile = path.join(CFG.tempDir, 'snitch');
    CFG.selectionFile = path.join(CFG.tempDir, 'selection');
    fs.writeFileSync(CFG.canaryFile, '');
    fs.watch(CFG.canaryFile, (eventType) => {
        if (eventType === 'change') {
            handleCanaryFileChange();
        } else if (eventType === 'rename') {
            vscode.window.showErrorMessage(`Issue detected with extension ${CFG.extensionName}. You may have to reload it.`);
        }
    });
    return true;
}

/** Interpreting the terminal output and turning them into a vscode command */
function openFiles(data: string) {
    const filePaths = data.split('\n').filter(s => s !== '');
    assert(filePaths.length > 0);
    filePaths.forEach(p => {
        const [file, lineTmp, charTmp] = p.split(':', 3);
        let line = 0, char = 0;
        let range = new vscode.Range(0, 0, 0, 0);
        if (lineTmp !== undefined) {
            if (charTmp !== undefined) {
                char = parseInt(charTmp) - 1;  // 1 based in rg, 0 based in VS Code
            }
            line = parseInt(lineTmp) - 1;  // 1 based in rg, 0 based in VS Code
            assert(line >= 0);
            assert(char >= 0);
        }
        vscode.window.showTextDocument(
            vscode.Uri.file(file),
            { preview: false, selection: new vscode.Range(line, char, line, char) });
    });
}

/** Logic of what to do when the user completed a command invocation on the terminal */
function handleCanaryFileChange() {
    if (CFG.clearTerminalAfterUse) {
        term.sendText('clear');
    }

    fs.readFile(CFG.canaryFile, { encoding: 'utf-8' }, (err, data) => {
        if (err) {
            // We shouldn't really end up here. Maybe leave the terminal around in this case...
            vscode.window.showWarningMessage('Something went wrong but we don\'t know what... Did you clean out your /tmp folder?');
        } else {
            const commandWasSuccess = data.length > 0 && data[0] !== '1';

            // open the file(s)
            if (commandWasSuccess) {
                openFiles(data);
            }

            if (commandWasSuccess && CFG.hideTerminalAfterSuccess) {
                term.hide();
            } else if (!commandWasSuccess && CFG.hideTerminalAfterFail) {
                term.hide();
            } else {
                // Don't hide the terminal and make clippy angry
            }
        }
    });
}

function createTerminal() {
    term = vscode.window.createTerminal({
        name: 'F️indItFaster',
        hideFromUser: true,
        env: {
            /* eslint-disable @typescript-eslint/naming-convention */
            HISTCONTROL: 'ignoreboth',  // bash
            // HISTORY_IGNORE: '*',        // zsh
            FIND_FILES_PREVIEW_ENABLED: CFG.findFilesPreviewEnabled ? '1' : '0',
            FIND_FILES_PREVIEW_COMMAND: CFG.findFilesPreviewCommand,
            FIND_FILES_PREVIEW_WINDOW_CONFIG: CFG.findFilesPreviewWindowConfig,
            FIND_WITHIN_FILES_PREVIEW_ENABLED: CFG.findWithinFilesPreviewEnabled ? '1' : '0',
            FIND_WITHIN_FILES_PREVIEW_COMMAND: CFG.findWithinFilesPreviewCommand,
            FIND_WITHIN_FILES_PREVIEW_WINDOW_CONFIG: CFG.findWithinFilesPreviewWindowConfig,
            GLOBS: CFG.useWorkspaceSearchExcludes ? getIgnoreString() : '',
            CANARY_FILE: CFG.canaryFile,
            SELECTION_FILE: CFG.selectionFile,
            EXPLAIN_FILE: path.join(CFG.tempDir, 'paths_explain'),
            /* eslint-enable @typescript-eslint/naming-convention */
        },
    });
}

function getWorkspaceFoldersAsString() {
    // For bash invocation. Need to wrap in quotes so spaces within paths don't
    // split the path into two strings.
    return CFG.searchPaths.reduce((x, y) => x + ` '${y}'`, '');
}

function getCommandString(cmd: Command, withArgs: boolean = true, withTextSelection: boolean = true) {
    assert(cmd.uri);
    let ret = '';
    const cmdPath = cmd.uri.fsPath;
    if (CFG.useEditorSelectionAsQuery && withTextSelection) {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const selection = editor.selection;
            if (!selection.isEmpty) {
                //
                // Fun story on text selection:
                // My first idea was to use an env var to capture the selection.
                // My first test was to use a selection that contained shell script...
                // This breaks. And fixing it is not easy. See https://unix.stackexchange.com/a/600214/128132.
                // So perhaps we should write this to file, and see if we can get bash to interpret this as a
                // string. We'll use an env var to indicate there is a selection so we don't need to read a
                // file in the general no-selection case, and we don't have to clear the file after having
                // used the selection.
                //
                const selectionText = editor.document.getText(selection);
                fs.writeFileSync(CFG.selectionFile, selectionText);
                ret += 'HAS_SELECTION=1 ';
            }
        }
    }
    ret += cmdPath;
    if (withArgs) {
        let paths = getWorkspaceFoldersAsString();
        ret += ` ${paths}`;
    }
    return ret;
}

function getIgnoreGlobs() {
    const exclude = vscode.workspace.getConfiguration('search.exclude');  // doesn't work though the docs say it should?
    const globs: string[] = [];
    Object.entries(exclude).forEach(([k, v]) => {
        // Messy proxy object stuff
        if (typeof v === 'function') { return; }
        if (v) { globs.push(`!${k}`); }
    });
    return globs;
}

function getIgnoreString() {
    const globs = getIgnoreGlobs();
    // We separate by colons so we can have spaces in the globs
    return globs.reduce((x, y) => x + `${y}:`, '');
}

function executeTerminalCommand(cmd: string) {
    getIgnoreGlobs();
    if (!CFG.flightCheckPassed && !CFG.disableStartupChecks) {
        if (!reinitialize()) {
            return;
        }
    }

    if (!term || term.exitStatus !== undefined) {
        createTerminal();
        term.sendText('PS1="::: Terminal allocated for FindItFaster. Do not use. ::: " bash');
    }

    assert(cmd in commands);
    const cb = commands[cmd].preRunCallback;
    if (cb !== undefined) { cb(); }
    term.sendText(getCommandString(commands[cmd]));
    if (CFG.showMaximizedTerminal) {
        vscode.commands.executeCommand('workbench.action.toggleMaximizedPanel');
    }
    term.show();
}
