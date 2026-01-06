# TDLR TABS Discovery Actor

This Apify actor discovers TDLR (Texas Department of Licensing and Regulation) project numbers from the Texas TABS search page.

## Features

- Searches by registration date range
- Optional filtering by city, county, and status
- Paginates through all results automatically
- Sends discovered projects to a webhook endpoint
- Extracts project metadata including name, cost, work type, etc.

## Input Schema

```json
{
  "startDate": "2025-01-01",
  "endDate": "2025-01-31",
  "city": "Austin",
  "county": "Travis",
  "status": "Project Registered",
  "maxResults": 1000,
  "webhookUrl": "https://your-supabase-url.supabase.co/functions/v1/apify-webhook",
  "webhookPayload": {
    "scrapeRunId": "uuid-here",
    "userId": "user-uuid-here"
  }
}
```

### Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `startDate` | Yes | Start of registration date range (YYYY-MM-DD) |
| `endDate` | Yes | End of registration date range (YYYY-MM-DD) |
| `city` | No | Filter by city name |
| `county` | No | Filter by county name |
| `status` | No | Filter by project status |
| `maxResults` | No | Maximum projects to discover (default: 1000) |
| `webhookUrl` | No | URL to POST results when complete |
| `webhookPayload` | No | Additional data to include in webhook |

## Output

Each discovered project contains:

```json
{
  "project_no": "TABS2026008685",
  "project_name": "Example Project",
  "registered_date": "12/20/2025",
  "status": "Project Registered",
  "facility_name": "Example Facility",
  "city": "Austin",
  "county": "Travis",
  "work_type": "New Construction",
  "cost": "$500,000",
  "cost_numeric": 500000,
  "detail_url": "https://www.tdlr.texas.gov/TABS/Search/Project/TABS2026008685"
}
```

## Deployment

1. Install Apify CLI: `npm install -g apify-cli`
2. Login to Apify: `apify login`
3. Navigate to this directory: `cd apify-actors/tdlr-tabs-discovery`
4. Push to Apify: `apify push`

## Webhook Integration

Configure your webhook URL to receive discovered projects. The webhook will receive:

```json
{
  "type": "discovery",
  "scrapeRunId": "from-webhook-payload",
  "userId": "from-webhook-payload",
  "items": [
    { /* project data */ }
  ]
}
```
