# Custera HRIS — resource-aligned functional scope

This is an original HR information management system mapped to the supplied HR workflow reference screens. It is not a visual, brand, asset or source-code copy of HR.MY or another third-party product.

## Included in this release

### Employee centre and dossier
- Quick employee entry: ID, name, gender, date of birth, nationality, national ID, passport, position and account invitation fields.
- Personal, job and employment-term details.
- Salary and payment profile with earnings, deductions, bonus and statutory-contribution component lists.
- Family, contact, emergency-contact, health, privacy and remarks sections.
- Employee photo URL field and self-profile-update control.
- Employee record history: placement, employment term, education, experience, training and legal document.
- Custom-field designer: short text, multi-line text, yes/no, dropdown and date.

### Access and administration
- Custom roles with per-module toggles.
- HR roles with a view/modify permission matrix.
- Employee web-account register: enable, disable, role assignment and temporary-password setup.
- Reference data setup: job position, branch, level, bank, ethnicity, religion, payment method, job type, marital status, relationship and blood type.
- Department configuration.

### Leave, claims, attendance, documents and incident
- Leave application/review, leave planner, entitlements, leave types, earning-policy records, workday profiles, holidays and configurable leave-workflow templates.
- Expense claims, review queue, claim categories, claim types, transaction report and configurable claim-workflow templates.
- Attendance time clock, field check-in, time-clock report, workday profiles and holidays.
- Document register, employee visibility, pending/approved/rejected review status and configurable document-workflow templates.
- Incident cases, category/cause, incident type, decision and review status.

### Payroll and audit
- Draft payroll runs and draft/published payslips.
- The payroll draft totals basic salary plus the employee profile’s earnings/bonus less deductions/statutory-contribution components.
- Audit log for key actions.

## Important operational limits

This release deliberately does **not** claim the following as production-ready:

1. Singapore/Malaysia statutory payroll (CPF, SDL, FWL, IRAS, PCB, tax and legislative updates).
2. Email delivery, password-reset mail or secure invitation links.
3. True multi-step workflow execution. Workflow templates are configurable; leave/claim/document approvals currently use the existing manager/admin review action.
4. Binary document/photo upload, virus scanning, retention policy or private object storage. Documents and photos use URLs/metadata.
5. MFA, SSO, encryption-key management, backup monitoring, data-retention controls, penetration testing or legal/privacy review.
6. Recruitment, applicant tracking, onboarding/offboarding checklists and report exports.

Use a test database until each workflow is accepted by HR, payroll, IT and management. Make a database backup before upgrading any system that already contains data.
