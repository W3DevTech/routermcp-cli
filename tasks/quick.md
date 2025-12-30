As of now we can spin up HTTP servers if defined within routermcp.json.

Can you also implement a plan that that it can be spin up in these ways as well:

# stdio → SSE
```
bunx -y routermcp  \
    --stdio "npx -y @modelcontextprotocol/server-filesystem ./my-folder" \
    --port 8000 --baseUrl http://localhost:8000 \
    --ssePath /sse --messagePath /message
```

# stdio → Streamable HTTP

## stateless mode

```
npx -y routermcp \
    --stdio "npx -y @modelcontextprotocol/server-filesystem ./my-folder" \
    --outputTransport streamableHttp \
    --port 8000
```

## statefull mode
```
npx -y routermcp \
    --stdio "npx -y @modelcontextprotocol/server-filesystem ./my-folder" \
    --outputTransport streamableHttp --stateful \
    --sessionTimeout 60000 --port 8000
```

You can refer to this repo via deepwiki to understand how to get this implemented in this repo context:
https://github.com/supercorp-ai/supergateway