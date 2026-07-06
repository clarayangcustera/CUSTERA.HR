# Custera HRIS

An **original, full-stack HR management system starter**. It is built as a working application—not a dashboard mock-up—and includes database-backed employee records, role-based access, leave and claim approvals, attendance clocking, payroll runs, document register and audit logs.

## What works now

- Role-based sign-in: **Admin, Manager and Employee**
- Employee centre with quick entry plus a full employee dossier: personal, job, salary/payment, family, contact/emergency, health, privacy, remarks and custom fields
- Employee history records: placement, employment terms, education, experience, training and legal documents
- Custom-field designer and reference-data setup
- Custom roles, HR permission-matrix roles and employee web-account setup
- Leave applications, approval/rejection, planner, entitlements, leave types, earning policies, workdays, holidays and workflow templates
- Expense claims, review, claim categories/types, transaction report and workflow templates
- Time clock, field check-in, attendance reports and workday/holiday setup
- Document register, employee visibility and approve/reject review state
- Incident cases, causes/categories, incident types and decisions
- Draft payroll runs/payslips, payroll publication and audit logs
- PostgreSQL database, Docker deployment, health check and GitHub Actions CI

## Important scope note

This package is a deployable **resource-aligned HRIS release**. It includes database-backed forms and configuration pages for the workflows in the submitted reference screens, but it is not a production statutory-payroll or enterprise-security product. Before using real payroll or employee data, add country-specific payroll rules, secure file storage/scanning, email/SMS provider, MFA, backup monitoring, a true multi-step workflow engine and a security/privacy review. The interface and source code are original; they do not include HR.MY code, branding or copied assets.

## Fastest local deployment (recommended)

1. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/).
2. Optional but recommended: create a `.env` file by copying `.env.example`, then set a private `JWT_SECRET` and `DEMO_PASSWORD`.
3. Run:

```bash
docker compose up --build
```

5. Open `http://localhost:8080`.

Demo admin account:

```text
Email: admin@custera-hris.local
Password: ChangeMe123!
```

Change these values in `.env` before public deployment.

## Development mode

You need Node.js 20+ and PostgreSQL 16+.

```bash
npm install
cp .env.example .env
npm run dev
```

- Web development app: `http://localhost:5173`
- API: `http://localhost:8080/api/health`

## Upload to GitHub

Create a new empty GitHub repository, then run from this folder:

```bash
git init
git add .
git commit -m "Initial Custera HRIS"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPOSITORY.git
git push -u origin main
```

Do **not** upload your `.env` file or real employee data.

## Deploy from GitHub using Render

This repository includes `render.yaml`.

1. Push the code to GitHub.
2. In Render, choose **New +** → **Blueprint**.
3. Connect the GitHub repository and approve the proposed PostgreSQL database and web service.
4. Set a strong `JWT_SECRET` in Render Environment settings.
5. Open the service URL when deployment is complete.

The system is a single Docker web service. It serves the React interface and Express API from the same URL, with PostgreSQL as its database.

## Deployment environment variables

| Variable | Required | Purpose |
|---|---:|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `JWT_SECRET` | Yes | Long random secret used to sign sessions |
| `PORT` | Yes | HTTP port, usually `8080` |
| `SEED_DEMO` | Recommended for first deployment | Creates demo organisation and accounts when `true` |
| `DEMO_ADMIN_EMAIL` | Recommended | Initial administrator email |
| `DEMO_PASSWORD` | Recommended | Initial administrator password; change it immediately |
| `CORS_ORIGIN` | Optional | Only required when frontend is hosted separately |

## Main folders

```text
apps/api/        Express API and PostgreSQL schema
apps/web/        React interface
.github/         GitHub Actions quality checks
Dockerfile       Single-service production image
docker-compose.yml  Local full-stack deployment
render.yaml      GitHub-to-Render blueprint
docs/            System scope and data map
```

## API health check

```text
GET /api/health
```

## License

MIT. See `LICENSE`.

## Render upgrade note

For the repository structure already used by `CUSTERA.HR`, replace the contents of the existing `custera-hris` folder with this release and commit them. Keep Render configured as:

```text
Root Directory: custera-hris
Dockerfile Path: Dockerfile
Docker Build Context Directory: .
```

The database schema upgrades are additive and run at application start. Back up your database before deploying to a system containing real HR data.
