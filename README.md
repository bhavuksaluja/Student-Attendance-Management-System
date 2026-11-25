# Student Attendance Management System

A React and Express attendance application using MongoDB Atlas. This project keeps the original course and batch screens: a course is used as a subject, and a batch is a teacher-assigned class section for that subject.

## Requirements

- Node.js 20.19 or newer
- MongoDB Atlas database and network access for your development computer or hosting service
- Optional SMTP account for automatic attendance shortage emails

## Local setup

1. Open this project folder in VS Code.
2. Install dependencies with `npm install`.
3. Copy `.env.example` to `.env`.
4. Set `MONGODB_URI` to your own Atlas connection string. Do not use or commit a real database password in source control.
5. Set `JWT_SECRET` to a private random value of at least 32 characters.
6. Run `npm run seed` once to create the demonstration users and sample attendance data.
7. Run `npm run dev` and open `http://localhost:3000`.

The app will not start without `MONGODB_URI`. This prevents attendance data from silently disappearing into process memory when the database is unavailable.

## Demo logins

| Role | Email | Password |
|---|---|---|
| Admin | `admin@classattend.com` | `Admin@123` |
| Teacher | `ananya.iyer@classattend.com` | `Teacher@123` |
| Student | `rahul.student@classattend.com` | `Student@123` |

These are development demo accounts. Change or remove them before using a public deployment.

## Main features

- Admin (displayed as Head Dean) management for subjects, class sections, faculty, and student records. The included demonstration subjects are Backend Development, Data Structures and Algorithms, and System Design.
- Individual and CSV subject enrollment for existing students. CSV columns: `Student ID` and optional `Batch Code`.
- Teacher attendance grid with bulk present, absent, late, and leave marking. Every active enrollee must be marked before saving.
- A server-enforced 24-hour edit window. An admin can unlock an older session, with the action recorded in the audit log.
- Student-only attendance access with subject-wise percentages, minimum-threshold progress, and absent dates.
- Subject, student, and date-filtered reports, server-side report pagination and sorting, and CSV export.
- Attendance records have a unique `{ sessionId, studentId }` index. Enrollments have a unique `{ studentId, batchId }` index. Bulk attendance uses MongoDB `bulkWrite`.
- Shortage emails are sent only when a student's subject percentage crosses below that subject's minimum. Configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM` in `.env` to enable delivery. Leave SMTP blank to keep the in-app shortage flags without email delivery.

## Build and run

```sh
npm run lint
npm run build
npm start
```

`npm start` serves both the API and built React single-page app. The Express production fallback supports refreshing routes such as `/student-portal`.

## Deployment

For a single-service deployment, use a Node host such as Render:

- Build command: `npm install && npm run build`
- Start command: `npm start`
- Set `MONGODB_URI`, `JWT_SECRET`, and `CLIENT_URL` in the host's environment settings. Add SMTP variables only when email delivery is configured.
- In MongoDB Atlas, create a database user and allow the host's outbound network access. Avoid embedding credentials in the ZIP or Git repository.

For a separate static frontend deployment, set `VITE_API_URL` to the backend origin and set `CLIENT_URL` to the frontend origin. The `public/_redirects` file is included for Netlify SPA routing.

## Branding

The login uses the Chitkara University wordmark image served from the university's official website. The application requires internet access for that logo; the rest of the user interface assets are local.

## Data model mapping

The original application stores students against a default batch for backward compatibility. Active `Enrollment` records are now the source of truth for class rosters, so a student can be enrolled in more than one subject batch while historical attendance remains attached to its original class. `Course` records hold subject metadata such as department, semester, and minimum attendance percentage.
