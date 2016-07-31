'use strict';

import * as vscode from 'vscode';
import * as child_process from 'child_process';

let output: vscode.OutputChannel;

function log(message: string, useOutput: boolean) {
	if(useOutput) {
		output.appendLine(message);
	} else {
		console.log(`${output.name}: ${message}`);
	}
}

export function activate(context: vscode.ExtensionContext) {
	output = vscode.window.createOutputChannel("LÖVE Launcher");

	let disposable = vscode.commands.registerCommand('lovelauncher.launch', () => {
		let config = vscode.workspace.getConfiguration('lovelauncher');
		let useOutput = config.get<boolean>('useOutput');
		let path = config.get<string>('path');
		let args = config.get<string>('args');
		let cwd = vscode.workspace.rootPath;
		let process = child_process.spawn(`${path}`, [".", args], {cwd});

		log(`Spawning process: "${path}" "${cwd}" ${args}`, useOutput);

		if(useOutput) {
			process.stderr.on('data', (data) => {
				output.append(data.toString());
			});

			process.stdout.on('data', (data) => {
				output.append(data.toString());
			});
		}

		process.on('error', (err) => {
			log(`Could not spawn process: ${err}`, useOutput);
		});

		process.on('close', (code) => {
			log(`Process exited with code ${code}`, useOutput);
		});
	});

	context.subscriptions.push(disposable);
}

export function deactivate() {
	output.hide();
	output.dispose();
}
