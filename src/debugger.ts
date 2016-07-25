'use strict';

import {
	DebugSession,
	InitializedEvent, TerminatedEvent, StoppedEvent, BreakpointEvent, OutputEvent, Event,
	Thread, StackFrame, Scope, Source, Handles, Breakpoint
} from 'vscode-debugadapter';
import {DebugProtocol} from 'vscode-debugprotocol';
import * as child_process from 'child_process';
import * as net from 'net';

export interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	host: string;
	port: number;
	path: string;
	directory: string;
}

class DebugBreakpoint {
	breakpoint: DebugProtocol.SourceBreakpoint;
	source: Source;
}

class DebugVariable {
	name: string;
	value: string;
	type: string;
	children: DebugVariable[];
}

class DebugFrame {
	frame: StackFrame;
	scopes: DebugVariable[];
}

class DebugThread {
	socket: net.Socket;
	frames: DebugFrame[];
}

class LoveDebugSession extends DebugSession {
	private directory: string;
	private process: child_process.ChildProcess;
	private server: net.Server;
	private threadId: number;
	private handles: Handles<DebugVariable>;
	private breakpoints: DebugBreakpoint[];
	private threads: DebugThread[];

	public constructor() {
		super();

		this.directory = "";
		this.server = net.createServer();
		this.threadId = 0;
		this.handles = new Handles<DebugVariable>();
		this.breakpoints = new Array<DebugBreakpoint>();
		this.threads = new Array<DebugThread>();

		this.setDebuggerLinesStartAt1(true);
	}

	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
		this.sendEvent(new OutputEvent("initializeRequest\n", 'stdout'));
		this.sendEvent(new InitializedEvent());

		response.body = {
			supportsConfigurationDoneRequest: true,
			supportsFunctionBreakpoints: true,
			supportsSetVariable: true
		};

		this.sendResponse(response);
	}

	protected launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments): void {
		this.directory = args.directory;

		let server = this.server;

		server.on('listening', () => {
			let cwd = args.directory.replace(/\\/g, '/');
			let cmd = `"${args.path}" "${cwd}"`;

			this.sendEvent(new OutputEvent(`${cmd}\n`, 'stdout'));

			this.process = child_process.exec(cmd, {cwd}, () => {
				this.sendEvent(new TerminatedEvent());
			});

			let process = this.process;

			process.stderr.on('data', (data) => {
				this.sendEvent(new OutputEvent(data, 'stderr'));
			});

			process.stdout.on('data', (data) => {
				this.sendEvent(new OutputEvent(data, 'stdout'));
			});

			server.on('connection', (socket: net.Socket) => {
				this.sendEvent(new OutputEvent(`Connection established: ${socket.remoteAddress}:${socket.remotePort}\n`, 'stdout'));

				let thread = <DebugThread> {socket, frames: []};
				let buffer = "";

				socket.on('data', (data: Buffer) => {
					buffer += data.toString();

					if(buffer.indexOf('\r\n') > -1) {
						let messages = buffer.split("\r\n");

						messages.pop();
						messages.forEach(message => {
							try {
								let data = JSON.parse(message);

								// this.sendEvent(new OutputEvent(`${message}\n`, 'stdout'));
								switch(data.type) {
									case 'breakpoint':
										thread.frames = [];

										data.body.stack.forEach((stack, index) => {
											let name = stack.name as string;
											let file = stack.file as string;
											let line = stack.line as number;
											let frame = new StackFrame(index, name, new Source(name, this.directory + file), line, 0);
											let children = this.deserializeVariables(stack.scope);
											let scopes = new Array<DebugVariable>();

											scopes.push({
												name: "Local",
												value: "",
												type: "Scope",
												children: children[0].children
											} as DebugVariable);

											scopes.push({
												name: "Global",
												value: "",
												type: "Scope",
												children: this.deserializeVariables(data.body.scope)[0].children
											} as DebugVariable);

											thread.frames.push({frame, scopes} as DebugFrame);
										});

										this.sendEvent(new OutputEvent(`Beakpoint on ${thread.frames[0].frame.name}\n`, 'stdout'));
										this.sendEvent(new StoppedEvent("breakpoint", this.threads.indexOf(thread)));
										break;
								}
							} catch (error) {
								this.sendEvent(new OutputEvent(`Error (${error}) parsing: ($: ${message} (${message.length}) from ${socket.remoteAddress}:${socket.remotePort}\n`, 'stdout'));
							}

							buffer = buffer.substring(message.length + 2);
						});
					}
				});

				socket.on('close', () => {
					this.threads.splice(this.threads.indexOf(thread), 1);
				});

				this.threads.push(thread);
				this.sendBreakpoints();
			});

			this.sendResponse(response);
		});

		server.on('error', (error: Error) => {
			response.success = false;
			response.message = `Server Error:  ${error.message}`;

			this.sendResponse(response);
		});

		server.listen(args.port, args.host);

		this.sendEvent(new OutputEvent("launchRequest\n", 'stdout'));
	}

	protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments): void {
		this.sendEvent(new OutputEvent("disconnectRequest\n", 'stdout'));

		this.server.close();
		this.process.kill('SIGHUP');

		super.disconnectRequest(response, args);
	}

	protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {
		this.sendEvent(new OutputEvent(`setBreakPointsRequest ${args.source.name}\n`, 'stdout'));

		const breakpoints = new Array<Breakpoint>();

		this.breakpoints = this.breakpoints.filter(element => {
			return element.source.path != args.source.path;
		});

		args.breakpoints.forEach(breakpoint => {
			let source = args.source;

			breakpoints.push(new Breakpoint(true, breakpoint.line, 0, new Source(args.source.name, args.source.path)));
			this.breakpoints.push({breakpoint, source} as DebugBreakpoint)
		});

		response.body = {breakpoints};

		this.sendBreakpoints();
		this.sendResponse(response);
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
		const threads = new Array<Thread>();

		this.threads.forEach((thread, index) => {
			threads.push(new Thread(index, `Thread #${index}`));
		});

		response.body = {threads};

		this.sendResponse(response);
	}

	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {
		let thread = this.threads[args.threadId];

		this.threadId = args.threadId;

		if(thread) {
			let stackFrames = new Array<StackFrame>();

			thread.frames.forEach(frame => {
				stackFrames.push(frame.frame);
			});

			let totalFrames = stackFrames.length;

			response.body = {stackFrames, totalFrames};
		} else {
			response.success = false;
			response.message = `Could not find Thread #${args.threadId}`;
		}

		this.sendResponse(response);
	}

	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
		let thread = this.threads[this.threadId];

		this.handles.reset();

		if(thread) {
			let frame = thread.frames[args.frameId];

			if(frame) {
				let scopes = new Array<Scope>();

				frame.scopes.forEach(scope => {
					scopes.push(new Scope(scope.name, this.handles.create(scope)));
				});

				response.body = {scopes};
			} else {
				response.success = false;
				response.message = `Could not find Frame #${args.frameId}`;
			}
		} else {
			response.success = false;
			response.message = `Could not find Thread #${this.threadId}`;
		}

		this.sendResponse(response);
	}

	protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): void {
		let variablesRef = this.handles.get(args.variablesReference);

		if(variablesRef) {
			let variables = new Array<DebugProtocol.Variable>();

			variablesRef.children.forEach(variable => {
				let variablesReference = 0;

				if(variable.children.length > 0) {
					variablesReference = this.handles.create(variable);
				}

				variables.push({
					name: variable.name,
					type: variable.type,
					value: variable.value,
					variablesReference
				} as DebugProtocol.Variable);
			});

			response.body = {variables};
		} else {
			response.success = false;
			response.message = `Could not find Variables #${args.variablesReference}`;
		}

		this.sendResponse(response);
	}

	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
		this.sendEvent(new OutputEvent("continueRequest\n", 'stdout'));
		this.send(args.threadId, "continue");
		this.sendResponse(response);
		// this.sendEvent(new StoppedEvent("breakpoint", 0));
		// this.sendEvent(new BreakpointEvent("update", bps[0]));
		// this.sendEvent(new StoppedEvent("exception", 0));
		// this.sendEvent(new OutputEvent(`exception in line: ${ln}\n`, 'stderr'));
		// this.sendEvent(new TerminatedEvent());
	}

	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
		this.sendEvent(new OutputEvent("nextRequest\n", 'stdout'));
		this.sendResponse(response);
		// this.sendEvent(new StoppedEvent("step", 0));
	}

	protected setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments): void {
		this.sendEvent(new OutputEvent("setVariableRequest\n", 'stdout'));
		this.sendEvent(new OutputEvent(`${args.name} = ${args.value}\n`, 'stdout'));
		this.sendResponse(response);
	}

	private sendBreakpoints() {
		let breakpoints = {};

		this.breakpoints.forEach(data => {
			let source = data.source.path.replace(this.directory, '').replace(/\\/g, '/');

			if(!breakpoints[source]) {
				breakpoints[source] = {};
			}

			breakpoints[source][data.breakpoint.line] = true;
			this.sendEvent(new OutputEvent(`breakpoint ${this.directory} ${source} ${breakpoints[source]} ${data.breakpoint.line}\n`, 'stdout'));
		});

		this.broadcast('breakpoints', {breakpoints});
		this.sendEvent(new OutputEvent(`sendBreakpoints ${this.breakpoints.length}\n`, 'stdout'));
	}

	private deserializeVariables(stack: any[]): DebugVariable[] {
		let variables = new Array<DebugVariable>();
		let filteredVariables = new Array<DebugVariable>();

		stack.forEach(stackVariable => {
			let variable = {
				name: stackVariable.name,
				type: stackVariable.type,
				value: stackVariable.value,
				children: []
			} as DebugVariable;


			stackVariable.children.forEach(child => {
				variable.children.push(variables[child]);
			});

			variables.push(variable);

			if(stackVariable.depth == 0) {
				filteredVariables.push(variable);
			}
		});

		return filteredVariables;
	}

	private send(threadId: number, type: string, body?: Object): void {
		if(this.threads[threadId]) {
			body = body ? body : {};
			this.threads[threadId].socket.write(JSON.stringify({type, body}) + "\r\n");
			this.sendEvent(new OutputEvent(`Sent message of type "${type}" to Thread #${threadId}\n`, 'stdout'));
		} else {
			this.sendEvent(new OutputEvent(`Could not send message to Thread #${threadId}\n`, 'stderr'));
		}
	}

	private broadcast(type: string, body?: Object): void {
		for(let threadId = 0; threadId < this.threads.length; threadId++) {
			this.send(threadId, type, body);
		}
	}
}

DebugSession.run(LoveDebugSession);
