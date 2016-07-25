local socket = require("socket")
local json = require(... .. ".json")

local module = {}

module.breakpoints = {}

function module.send(type, body)
	if not module.socket then return end

	module.socket:send(json:encode({
		type = type,
		body = body or {}
	}) .. "\r\n")
end

function module.pump(block)
	if not module.socket then return end

	repeat
		local data, msg = module.socket:receive('*l')

		if data then
			local message = json:decode(data)

			if message.type == 'continue' then
				block = false
			elseif message.type == 'breakpoints' then
				print("RECEIVED BREAKPOINTS")
				module.breakpoints = message.body.breakpoints
			else
				print("UNIMPLEMENTED: " .. message.type)
			end
		elseif msg == 'closed' then
			block = false
			module.socket = nil

			print("DEBUGGER CONNECTION CLOSED.")
		end

		if block then
			if love.event then
				love.event.pump()
				love.event.poll()
			end

			if love.timer then
				love.timer.sleep(0.01)
			end
		end
	until not data and not block
end

function module.initialize(host, port)
	if module.socket then return end

	io.stdout:setvbuf("no")

	local host = host or "localhost"
	local port = port or 1357
	local tcp = socket.tcp()

	local res, err = tcp:connect(host, port)

	if res then
		tcp:settimeout(0)

		module.socket = tcp
		module.hook()
	elseif err then
		print("COULD NOT INITIALIZE DEBUGGER: " .. err)
	end
end

function module.variables(stack)
	local variables = {}
	local i = 1

	repeat
		local k, v = debug.getlocal(stack + 1, i)

		if k and k ~= "(*temporary)" then
			variables[k] = v
		end

		i = i + 1
	until not k

	return variables
end

function module.flatten(name, object, maxDepth, hashmap, result, structure, depth, parents)
	local hashmap = hashmap or {}
	local result = result or {}
	local structure = structure or {}
	local depth = depth or 0
	local parents = parents or {}

	parents[object] = true -- GOOD ENOUGH..

	if not hashmap[object] then
		local variable = {
			name = name,
			type = type(object),
			value = tostring(object),
			depth = depth,
			children = {}
		}

		if variable.type == 'table' and (not maxDepth or depth < maxDepth) then
			for k, v in pairs(object) do
				if not parents[v] then
					table.insert(variable.children, module.flatten(k, v, maxDepth, hashmap, result, structure, depth + 1, parents))
				end
			end
		end

		hashmap[object] = #result
		table.insert(result, variable)
	end

	if depth == 0 then
		return result
	else
		return hashmap[object]
	end
end

function module.hook()
	debug.sethook(function(hook)
		local info = debug.getinfo(2, "Sl")

		if module.breakpoints[info.short_src] and module.breakpoints[info.short_src][tostring(info.currentline)] then
			local stack = {}

			debug.traceback('', 2):gsub("\t(.-)\r?\n", function(line)
				local info = debug.getinfo(#stack + 4, "Sl")

				table.insert(stack, {
					name = line:gsub("(.-): in ", ""),
					file = info.short_src,
					line = info.currentline,
					scope = module.flatten("Local", module.variables(#stack + 4))
				})

				-- print("--------------------")
				-- print(stack[#stack].name)
				-- print(stack[#stack].file, stack[#stack].line)
				-- print("--------------------")
				-- for k, v in pairs(stack[#stack].variables) do
				-- 	print(k, tostring(v.value))
				-- end
				-- print("~~~~~~~~~~~~~~~~~~~~")
			end)

			module.send('breakpoint', {
				stack = stack,
				scope = module.flatten("Global", _G)
			})
			module.pump(true)
		end
	end, "lc")
end

return module
