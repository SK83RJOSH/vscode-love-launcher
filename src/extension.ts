'use strict';

import * as vscode from 'vscode';
import * as child_process from 'child_process';

let output: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext) {
	output = vscode.window.createOutputChannel("LÖVE Launcher");

	let disposable = vscode.commands.registerCommand('lovelauncher.launch', () => {
		let config = vscode.workspace.getConfiguration('lovelauncher');
		let useOutput = config.get<boolean>('useOutput');
		let path = config.get<string>('path');
		let args = config.get<string>('args');
		let cwd = vscode.workspace.rootPath;

		if(useOutput) {
			let cmd = `"${path}" "${cwd}" ${args}`;

			output.appendLine(`Executing: ${cmd}`);

			let process = child_process.exec(cmd, {cwd}, (error) => {
				if(error) {
					output.appendLine(`Error: ${error}`);
				}
			});

			process.stderr.on('data', (data) => {
				output.append(data);
			});

			process.stdout.on('data', (data) => {
				output.append(data);
			});
		} else {
			console.log(`Executing: ${path}`);

			let process = child_process.execFile(path, [".", args], {cwd}, (error) => {
				if(error) {
					console.log(`Error: ${error}`);
				}
			});
		}
	});

	context.subscriptions.push(disposable);
}

export function deactivate() {
	output.hide();
	output.dispose();
}