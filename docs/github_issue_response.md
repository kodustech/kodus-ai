Hi @Dentling,

Thanks for reporting this issue. For self-hosted instances, there are two ways to configure LLM providers, and based on your setup, I'd recommend using **Fixed Mode** instead of the BYOK web interface.

## Recommended Approach: Fixed Mode (Environment Variables)

For self-hosted deployments, we recommend using **Fixed Mode** via environment variables instead of the BYOK web interface. This is simpler and more reliable for self-hosted setups.

Configure your `.env` file with:

```env
# Fixed Mode Configuration (Recommended for Self-Hosted)
API_LLM_PROVIDER_MODEL="your-model-name"                    # e.g., "gpt-3.5-turbo"
API_OPENAI_FORCE_BASE_URL="https://your-api-endpoint.com/v1"  # Your OpenAI-compatible API URL
API_OPEN_AI_API_KEY="your-api-key"                          # Your API key
```

For OpenAI-compatible providers, you can use any endpoint. See our [cookbook guides](https://docs.kodus.io/cookbook/en) for specific provider configurations (Novita, Together AI, Fireworks, Groq, etc.).

## Troubleshooting the BYOK Web Interface Issue

If you prefer to use the BYOK web interface, the issue suggests that your organization may not be fully initialized. Here are some steps to troubleshoot:

1. **Verify database migrations completed:**
   ```bash
   # Check if migrations ran successfully
   docker logs kodus-orchestrator-prod | grep -i migration
   ```

2. **Check organization initialization:**
   - Ensure you completed the initial setup flow
   - Verify the organization was created properly

3. **Check API logs for errors:**
   ```bash
   docker logs kodus-orchestrator-prod | grep -i "byok\|organization"
   ```

4. **Verify database state:**
   ```sql
   -- Check organization_parameters table
   SELECT * FROM organization_parameters;
   
   -- Check if organization exists
   SELECT * FROM organizations;
   ```

## Next Steps

Please share:
- The exact error message from the network tab (screenshot or text)
- Relevant API logs around the BYOK setup attempt
- Whether you completed the initial setup flow before attempting BYOK configuration

For self-hosted deployments, **Fixed Mode is typically the better choice** as it's simpler and doesn't require the web interface setup. If you need help with a specific provider configuration, let me know which one you're using.

