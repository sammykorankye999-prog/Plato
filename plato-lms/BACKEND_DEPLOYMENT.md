# Deploy the Plato backend for web and Expo

The Flask application serves the desktop site and the pages shown by the Expo mobile app. They share the same backend URL, account sessions, MFA, roles, and database. The container includes `/healthz`, which returns `200` only when the app can reach its configured database.

## AWS deployment path

This project has an `apprunner.yaml` from an earlier setup. AWS App Runner stopped accepting new customers on April 30, 2026. For a new AWS deployment, use Amazon ECS Express Mode, which accepts a container image and provisions a public HTTPS endpoint.

### 1. Prepare AWS

Create your AWS account, enable MFA on the root user, create a least-privilege IAM identity for daily work, and set an AWS Budget alert before provisioning resources. ECS/Fargate, the load balancer, database, logs, storage, and data transfer can incur charges.

Use the AWS region `eu-north-1` (Europe/Stockholm) for the database, ECR repository, and ECS service. The RDS PostgreSQL database should stay private. Configure its security group to allow PostgreSQL traffic only from the ECS task security group; do not allow an internet IP range.

### 2. Build the backend image on GitHub Actions

This repository includes `.github/workflows/plato-ecr.yml`. GitHub Actions builds the Docker image, so Docker Desktop is not needed on your computer. The workflow uses GitHub's OIDC identity to assume a limited AWS role; it does not need a long-lived AWS access key.

First, create a **private** Amazon ECR repository named `plato-lms` in `eu-north-1`. In IAM, create an OIDC identity provider for `https://token.actions.githubusercontent.com` with audience `sts.amazonaws.com`. Create an IAM role named `GitHubPlatoECRPublisher` with this trust policy, replacing the account ID if needed:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Federated": "arn:aws:iam::AWS_ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"},
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        "token.actions.githubusercontent.com:sub": "repo:sammykorankye999-prog/Plato:ref:refs/heads/main"
      }
    }
  }]
}
```

Attach a permissions policy to that role. Replace `AWS_ACCOUNT_ID` with the account ID and use this JSON:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {"Effect": "Allow", "Action": "ecr:GetAuthorizationToken", "Resource": "*"},
    {"Effect": "Allow", "Action": ["ecr:BatchCheckLayerAvailability", "ecr:CompleteLayerUpload", "ecr:InitiateLayerUpload", "ecr:PutImage", "ecr:UploadLayerPart"], "Resource": "arn:aws:ecr:eu-north-1:AWS_ACCOUNT_ID:repository/plato-lms"}
  ]
}
```

In the GitHub repository, open **Settings → Secrets and variables → Actions → Variables** and add:

| Variable | Value |
| --- | --- |
| `AWS_ROLE_ARN` | `arn:aws:iam::AWS_ACCOUNT_ID:role/GitHubPlatoECRPublisher` |
| `AWS_REGION` | `eu-north-1` |
| `ECR_REPOSITORY` | `plato-lms` |

Commit and push the workflow to `main`. It builds and pushes `latest` and a commit-specific image tag to ECR whenever backend files change. Check **GitHub → Plato → Actions** for a green run; choose the `latest` image in ECS Express Mode.

### 3. Store configuration and deploy

In AWS Secrets Manager, create secrets for `SECRET_KEY`, `PASSWORD_PEPPER`, `TOTP_ENCRYPTION_KEY`, `BACKUP_ENCRYPTION_KEY`, `DATABASE_URL`, and `INSTRUCTOR_INVITE_CODE`. Generate distinct random keys for each; use a PostgreSQL SQLAlchemy URL such as `postgresql+psycopg://...` with TLS enabled. Never put secrets in the Docker image or GitHub.

In the AWS Console, open **Amazon ECS → Express mode → Create** and select the ECR image. Configure container port `8080`, health check path `/healthz`, production environment variables `APP_ENV=production`, `COOKIE_SECURE=1`, and `PORT=8080`, plus the Secrets Manager values. Choose the task execution and infrastructure roles. Set the task networking so it can reach the private RDS database; restrict inbound PostgreSQL access to the task security group. Review the price estimate and configuration before creating the service.

Wait for the service to become active and verify its HTTPS URL by opening `/healthz`; it should respond with `{"status":"ok"}`.

### 4. Connect the Expo app

In `mobile/.env`, set:

```dotenv
EXPO_PUBLIC_PLATO_URL=https://YOUR-ECS-SERVICE-URL
```

Restart Expo after changing the environment file. On a phone, this must be the deployed HTTPS URL (not `localhost`). The Expo app loads the Flask pages; accounts and course data stay in PostgreSQL on the backend. Do not put server secrets in `EXPO_PUBLIC_*` variables.

### 5. Create the first administrator

Register your account through the deployed site. Use a one-off database query from the authorized AWS database console to promote that account to `admin`:

```sql
UPDATE "user"
SET role = 'admin'
WHERE email = 'your-account-email' AND is_deleted = false;
```

Sign in and complete the required TOTP setup. Then turn off open registration from the Admin dashboard. Do not run sample-user seeding against the production database.

## Local container check

For local Docker runs, provide all required values through a private environment file and use a local database. Never copy `.env` into a container image. The same image can then be used for production with secrets supplied by the hosting platform.
