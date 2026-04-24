# Council Growth Planner

Membership & finance trajectory forecasting tool for Boy Scout councils.

## Deploying to Vercel (Free)

### Step 1 — Create a GitHub account
Go to https://github.com and sign up (free). Skip if you already have one.

### Step 2 — Create a new repository
1. Click the **+** icon in the top right → **New repository**
2. Name it `scouts-planner` (or anything you like)
3. Leave it **Public**
4. Click **Create repository**

### Step 3 — Upload these files
On the new repo page, click **uploading an existing file** (or drag and drop).
Upload ALL files maintaining this folder structure:

```
scouts-planner/
├── index.html
├── package.json
├── vite.config.js
├── public/
│   └── data.csv        ← your historical data lives here
└── src/
    ├── main.jsx
    └── App.jsx
```

Click **Commit changes**.

### Step 4 — Deploy on Vercel
1. Go to https://vercel.com and click **Sign Up** → **Continue with GitHub**
2. Click **Add New → Project**
3. Find your `scouts-planner` repo and click **Import**
4. Vercel auto-detects Vite. Click **Deploy**
5. Done — you get a permanent URL like `https://scouts-planner.vercel.app`

---

## Updating Historical Data

Edit `public/data.csv` directly in GitHub:
1. Open your repo on GitHub
2. Click `public/data.csv`
3. Click the **pencil icon** (Edit)
4. Change the numbers
5. Click **Commit changes**

Vercel redeploys automatically in ~30 seconds.

### CSV Format
```
year,label,month,membership,finance
1,2023-24,Jan,1820,1200
1,2023-24,Feb,1790,-800
...
2,2024-25,Jan,1910,1400
```

- `year`: 1 or 2 (which historical year)
- `label`: display name shown in charts
- `month`: Jan, Feb, Mar... (must match exactly)
- `membership`: headcount at end of that month
- `finance`: net cash flow for that month (positive = surplus, negative = deficit)

---

## Using the App

1. **Historical Data tab** — verify your data loaded correctly, or edit in-browser
2. **Membership tab** — drag either slider (count or %) to set your growth goal; targets update instantly
3. **Finance tab** — set starting balance and year-end goal; enter actuals monthly to track variance
4. **Seasonal Patterns tab** — see how the model interprets your historical seasonality
