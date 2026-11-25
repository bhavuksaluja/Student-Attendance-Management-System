import { Router, Response } from 'express';
import { db, AttendanceRecordDoc, getStudentsInBatch } from '../db.js';
import { authenticate, AuthRequest } from '../middleware/auth.js';
import nodemailer from 'nodemailer';
import { AttendanceRecordModel } from '../models.js';

const router = Router();

function attendancePercent(studentId: string, courseId?: string): number {
  let courseSessionIds: Set<string> | undefined;
  if (courseId) {
    const batchIds = new Set(db.batches.find((batch) => batch.courseId === courseId && getStudentsInBatch(batch._id).some((student) => student._id === studentId)).map((batch) => batch._id));
    courseSessionIds = new Set(db.attendanceSessions.find((session) => batchIds.has(session.batchId)).map((session) => session._id));
  }
  const records = db.attendanceRecords.find((record) => record.studentId === studentId && (!courseSessionIds || courseSessionIds.has(record.sessionId)));
  const settings = db.settings.findById('settings_default');
  const excused = records.filter((record) => record.status === 'excused').length;
  const eligible = settings?.excludeExcusedFromDenominator ? records.length - excused : records.length;
  const attended = records.filter((record) => record.status === 'present' || record.status === 'late').length;
  return eligible ? Math.round((attended / eligible) * 1000) / 10 : 100;
}

async function sendShortageAlert(email: string, name: string, subjectName: string, percent: number, threshold: number): Promise<boolean> {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return false;
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  await transporter.sendMail({
    from: SMTP_FROM || SMTP_USER,
    to: email,
    subject: `Low attendance in ${subjectName}`,
    text: `Hello ${name}, your attendance in ${subjectName} is ${percent}%, below the required ${threshold}%. Please contact your department if you need help.`,
  });
  return true;
}

// GET /api/attendance/sessions
router.get('/sessions', authenticate, (req: AuthRequest, res: Response) => {
  if (req.user?.role === 'student') {
    res.status(403).json({ error: 'Students cannot access classroom marking sessions.' });
    return;
  }
  const { batchId, date, startDate, endDate, page = '1', limit = '25' } = req.query;

  let sessions = db.attendanceSessions.find();

  // If teacher, only allowed to see batches assigned to them unless query specific
  if (req.user?.role === 'teacher') {
    const teacherBatches = db.batches.find((b) => b.teacherId === req.user?._id).map((b) => b._id);
    sessions = sessions.filter((s) => teacherBatches.includes(s.batchId));
  }

  if (batchId) {
    sessions = sessions.filter((s) => s.batchId === batchId);
  }

  if (date) {
    sessions = sessions.filter((s) => s.date === date);
  }

  if (startDate) {
    sessions = sessions.filter((s) => s.date >= String(startDate));
  }

  if (endDate) {
    sessions = sessions.filter((s) => s.date <= String(endDate));
  }

  // Enrich with batch details and stats
  const enriched = sessions.map((ses) => {
    const batch = db.batches.findById(ses.batchId);
    const creator = db.users.findById(ses.createdBy);
    const records = db.attendanceRecords.find((r) => r.sessionId === ses._id);

    const total = records.length;
    const present = records.filter((r) => r.status === 'present').length;
    const absent = records.filter((r) => r.status === 'absent').length;
    const late = records.filter((r) => r.status === 'late').length;
    const excused = records.filter((r) => r.status === 'excused').length;
    const rate = total > 0 ? Math.round(((present + late) / total) * 100) : 0;

    return {
      ...ses,
      batchName: batch?.name || 'Batch',
      batchCode: batch?.code || '',
      creatorName: creator?.name || 'Faculty',
      stats: {
        total,
        present,
        absent,
        late,
        excused,
        rate,
      },
    };
  });

  // Sort by date descending
  enriched.sort((a, b) => b.date.localeCompare(a.date) || String(b.period || '').localeCompare(String(a.period || '')));
  const pageNum = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(100, Math.max(1, Number(limit) || 25));
  res.json({ sessions: enriched.slice((pageNum - 1) * limitNum, pageNum * limitNum), total: enriched.length, page: pageNum, totalPages: Math.ceil(enriched.length / limitNum) });
});

// POST /api/attendance/sessions (Create or find existing session for batch and date)
router.post('/sessions', authenticate, (req: AuthRequest, res: Response) => {
  try {
    if (!['admin', 'teacher'].includes(req.user!.role)) {
      res.status(403).json({ error: 'Only teachers and admins can create class sessions.' });
      return;
    }
    const { batchId, date, sessionTitle, period = '1', topic = '' } = req.body;
    if (!batchId || !date) {
      res.status(400).json({ error: 'Batch ID and session date (YYYY-MM-DD) are required.' });
      return;
    }

    const batch = db.batches.findById(batchId);
    if (!batch) {
      res.status(404).json({ error: 'Batch not found.' });
      return;
    }

    // Role check: Admin or the teacher assigned to this batch
    if (req.user?.role === 'teacher' && batch.teacherId !== req.user._id) {
      res.status(403).json({ error: 'Permission denied: You are not authorized to mark attendance for this batch.' });
      return;
    }

    // Check duplicate session for batch & date
    let session = db.attendanceSessions.findOne((s) => s.batchId === batchId && s.date === date && (s.period || '1') === String(period));

    if (session) {
      // Reopening existing session: return session directly
      res.json({
        message: 'Loaded existing session for this date.',
        session,
        isExisting: true,
      });
      return;
    }

    const now = new Date().toISOString();
    const newSession = db.attendanceSessions.insert({
      _id: `ses_${batch.code.toLowerCase()}_${date}_p${String(period).replace(/[^a-zA-Z0-9_-]/g, '')}`,
      batchId,
      date,
      sessionTitle: sessionTitle ? sessionTitle.trim() : `${batch.name} - ${date}`,
      period: String(period),
      topic: String(topic || '').trim(),
      createdBy: req.user!._id,
      finalized: false,
      createdAt: now,
      updatedAt: now,
    });

    db.auditLogs.insert({
      _id: `log_${Date.now()}`,
      actorId: req.user!._id,
      actorName: req.user!.name,
      actorRole: req.user!.role,
      action: 'OPEN_SESSION',
      targetType: 'AttendanceSession',
      targetId: newSession._id,
      details: `Opened attendance session for ${batch.name} on ${date}.`,
      timestamp: now,
    });

    res.status(201).json({
      message: 'New attendance session created.',
      session: newSession,
      isExisting: false,
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to create session: ' + err.message });
  }
});

// GET /api/attendance/sessions/:id
router.get('/sessions/:id', authenticate, (req: AuthRequest, res: Response) => {
  const session = db.attendanceSessions.findById(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Attendance session not found.' });
    return;
  }

  const batch = db.batches.findById(session.batchId);
  if (!batch) {
    res.status(404).json({ error: 'Associated batch not found.' });
    return;
  }

  if (req.user?.role === 'student') {
    res.status(403).json({ error: 'Students cannot access classroom marking grids.' });
    return;
  }

  // Teacher check
  if (req.user?.role === 'teacher' && batch.teacherId !== req.user._id) {
    res.status(403).json({ error: 'Access denied: You are not authorized to view this batch session.' });
    return;
  }

  // Get all active students enrolled in this batch
  const enrolledStudents = getStudentsInBatch(batch._id).sort((a, b) => a.studentId.localeCompare(b.studentId));

  // Get existing attendance records for this session
  const records = db.attendanceRecords.find((r) => r.sessionId === session._id);
  const recordsMap = new Map<string, AttendanceRecordDoc>();
  for (const r of records) {
    recordsMap.set(r.studentId, r);
  }

  // Map student rows with their saved record if any
  const studentRows = enrolledStudents.map((st) => {
    const existingRec = recordsMap.get(st._id);
    return {
      studentId: st._id,
      studentCode: st.studentId,
      fullName: st.fullName,
      phone: st.phone,
      parentPhone: st.parentPhone,
      recordId: existingRec?._id || null,
      status: existingRec?.status || null, // null if unsaved
      notes: existingRec?.notes || '',
      lastModified: existingRec?.updatedAt || null,
    };
  });

  res.json({
    session: { ...session, lockedAfter24Hours: Date.now() - new Date(session.createdAt).getTime() > 24 * 60 * 60 * 1000 && !session.adminUnlockedAt },
    batch: {
      _id: batch._id,
      name: batch.name,
      code: batch.code,
      teacherId: batch.teacherId,
    },
    students: studentRows,
  });
});

// PUT /api/attendance/sessions/:id/records (Bulk save/update attendance)
router.put('/sessions/:id/records', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const session = db.attendanceSessions.findById(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Session not found.' });
      return;
    }

    if (!['admin', 'teacher'].includes(req.user!.role)) {
      res.status(403).json({ error: 'Only teachers and admins can mark attendance.' });
      return;
    }

    const batch = db.batches.findById(session.batchId);
    if (!batch) {
      res.status(404).json({ error: 'Batch not found.' });
      return;
    }

    if (req.user?.role === 'teacher' && batch.teacherId !== req.user._id) {
      res.status(403).json({ error: 'Unauthorized to mark attendance for this batch.' });
      return;
    }

    const pastEditWindow = Date.now() - new Date(session.createdAt).getTime() > 24 * 60 * 60 * 1000;
    if (req.user?.role === 'teacher' && pastEditWindow && !session.adminUnlockedAt) {
      res.status(423).json({ error: 'This session is locked because more than 24 hours have passed. Ask an admin to unlock it.' });
      return;
    }

    const { records: studentRecords, sessionTitle, topic } = req.body;
    if (!Array.isArray(studentRecords) || studentRecords.length === 0) {
      res.status(400).json({ error: 'Please provide attendance records array.' });
      return;
    }

    const enrolled = getStudentsInBatch(batch._id);
    const enrolledIds = new Set(enrolled.map((student) => student._id));
    const receivedIds = studentRecords.map((item: any) => item.studentId);
    if (studentRecords.some((item: any) => !enrolledIds.has(item.studentId)) || new Set(receivedIds).size !== receivedIds.length) {
      res.status(400).json({ error: 'Attendance must contain each enrolled student once, with no students from another batch.' });
      return;
    }
    if (receivedIds.length !== enrolledIds.size || studentRecords.some((item: any) => !['present', 'absent', 'late', 'excused'].includes(item.status))) {
      res.status(400).json({ error: 'Mark every enrolled student as present, absent, late, or leave before saving.' });
      return;
    }

    const now = new Date().toISOString();
    const settings = db.settings.findById('settings_default');
    const course = db.courses.findById(batch.courseId);
    const shortageThreshold = course?.minAttendancePct ?? settings?.lowAttendanceThreshold ?? 75;
    const previousPercent = new Map(enrolled.map((student) => [student._id, attendancePercent(student._id, batch.courseId)]));
    let presentCount = 0;
    let absentCount = 0;
    let lateCount = 0;
    let excusedCount = 0;

    const bulkOperations = studentRecords.map((item: any) => {
      const { studentId, status, notes } = item;
      if (status === 'present') presentCount++;
      else if (status === 'absent') absentCount++;
      else if (status === 'late') lateCount++;
      else if (status === 'excused') excusedCount++;

      const existing = db.attendanceRecords.findOne(
        (r) => r.sessionId === session._id && r.studentId === studentId
      );
      const nextRecord: AttendanceRecordDoc = existing ? {
        ...existing,
        status,
        notes: notes !== undefined ? notes : existing.notes,
        lastModifiedBy: req.user!._id,
        updatedAt: now,
      } : {
        _id: `rec_${session._id}_${studentId}`,
        sessionId: session._id,
        batchId: session.batchId,
        studentId,
        status,
        notes: notes || undefined,
        markedBy: req.user!._id,
        createdAt: now,
        updatedAt: now,
      };
      const set: Record<string, unknown> = { status, updatedAt: now, lastModifiedBy: req.user!._id };
      if (notes !== undefined) set.notes = notes || undefined;
      const setOnInsert = existing ? {} : {
        _id: nextRecord._id,
        sessionId: session._id,
        batchId: session.batchId,
        studentId,
        markedBy: req.user!._id,
        createdAt: now,
        ...(notes ? { notes } : {}),
      };
      return {
        nextRecord,
        operation: {
          updateOne: {
            filter: { sessionId: session._id, studentId },
            update: { $set: set, ...(existing ? {} : { $setOnInsert: setOnInsert }) },
            upsert: true,
          },
        },
      };
    });
    await AttendanceRecordModel.bulkWrite(bulkOperations.map(({ operation }) => operation), { ordered: true });
    bulkOperations.forEach(({ nextRecord }) => db.attendanceRecords.upsertLocal(nextRecord));

    for (const student of enrolled) {
      const percent = attendancePercent(student._id, batch.courseId);
      const alertedCourses = student.shortageAlertCourseIds || [];
      if (percent >= shortageThreshold && alertedCourses.includes(batch.courseId)) {
        db.students.update(student._id, { shortageAlertCourseIds: alertedCourses.filter((id) => id !== batch.courseId) });
      } else if (percent < shortageThreshold && (previousPercent.get(student._id) ?? 100) >= shortageThreshold && student.email && !alertedCourses.includes(batch.courseId)) {
        void sendShortageAlert(student.email, student.fullName, course?.name || batch.name, percent, shortageThreshold)
          .then((sent) => { if (sent) db.students.update(student._id, { shortageAlertCourseIds: [...alertedCourses, batch.courseId] }); })
          .catch((err) => console.error(`Unable to send attendance shortage email to ${student.email}:`, err.message));
      }
    }

    // Mark session as finalized and update title if provided
    db.attendanceSessions.update(session._id, {
      finalized: true,
      sessionTitle: sessionTitle ? sessionTitle.trim() : session.sessionTitle,
      topic: topic !== undefined ? String(topic).trim() : session.topic,
    });

    // Create Audit Log
    db.auditLogs.insert({
      _id: `log_${Date.now()}`,
      actorId: req.user!._id,
      actorName: req.user!.name,
      actorRole: req.user!.role,
      action: 'SUBMIT_ATTENDANCE',
      targetType: 'AttendanceSession',
      targetId: session._id,
      details: `Saved attendance for ${batch.name} (${session.date}): ${presentCount} Present, ${absentCount} Absent, ${lateCount} Late, ${excusedCount} Excused.`,
      timestamp: now,
    });

    res.json({
      message: 'Attendance saved successfully.',
      summary: {
        total: studentRecords.length,
        present: presentCount,
        absent: absentCount,
        late: lateCount,
        excused: excusedCount,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to save attendance: ' + err.message });
  }
});

// PATCH /api/attendance/records/:id (Individual record correction with audit trail)
router.post('/sessions/:id/unlock', authenticate, (req: AuthRequest, res: Response) => {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ error: 'Only an admin can unlock a session after its 24-hour edit window.' });
    return;
  }
  const session = db.attendanceSessions.findById(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Attendance session not found.' });
    return;
  }
  const now = new Date().toISOString();
  db.attendanceSessions.update(session._id, { adminUnlockedAt: now });
  db.auditLogs.insert({
    _id: `log_${Date.now()}`,
    actorId: req.user._id,
    actorName: req.user.name,
    actorRole: req.user.role,
    action: 'UNLOCK_ATTENDANCE_SESSION',
    targetType: 'AttendanceSession',
    targetId: session._id,
    details: `Admin unlocked the session for ${session.date}, period ${session.period || '1'}.`,
    timestamp: now,
  });
  res.json({ message: 'Session unlocked. The assigned teacher can now edit it.', session: { ...session, adminUnlockedAt: now } });
});

router.patch('/records/:id', authenticate, (req: AuthRequest, res: Response) => {
  try {
    const record = db.attendanceRecords.findById(req.params.id);
    if (!record) {
      res.status(404).json({ error: 'Attendance record not found.' });
      return;
    }

    const session = db.attendanceSessions.findById(record.sessionId);
    const batch = db.batches.findById(record.batchId);

    if (!['admin', 'teacher'].includes(req.user!.role)) {
      res.status(403).json({ error: 'Only teachers and admins can correct attendance records.' });
      return;
    }

    if (req.user?.role === 'teacher' && batch && batch.teacherId !== req.user._id) {
      res.status(403).json({ error: 'Unauthorized to edit records for this batch.' });
      return;
    }

    if (req.user?.role === 'teacher' && session && Date.now() - new Date(session.createdAt).getTime() > 24 * 60 * 60 * 1000 && !session.adminUnlockedAt) {
      res.status(423).json({ error: 'This session is locked. Ask an admin to unlock it before editing.' });
      return;
    }

    const { status, notes, reason } = req.body;
    if (!status || !['present', 'absent', 'late', 'excused'].includes(status)) {
      res.status(400).json({ error: 'Valid status is required.' });
      return;
    }

    const prevStatus = record.status;
    const student = db.students.findById(record.studentId);
    const course = batch ? db.courses.findById(batch.courseId) : null;
    const threshold = course?.minAttendancePct ?? db.settings.findById('settings_default')?.lowAttendanceThreshold ?? 75;
    const previousPercent = attendancePercent(record.studentId, batch ? db.courses.findById(batch.courseId)?._id : undefined);
    const now = new Date().toISOString();

    const updated = db.attendanceRecords.update(record._id, {
      status,
      notes: notes !== undefined ? notes : record.notes,
      lastModifiedBy: req.user!._id,
    });

    if (student && batch) {
      const percent = attendancePercent(student._id, batch.courseId);
      const alertedCourses = student.shortageAlertCourseIds || [];
      if (percent >= threshold && alertedCourses.includes(batch.courseId)) {
        db.students.update(student._id, { shortageAlertCourseIds: alertedCourses.filter((id) => id !== batch.courseId) });
      } else if (percent < threshold && previousPercent >= threshold && student.email && !alertedCourses.includes(batch.courseId)) {
        void sendShortageAlert(student.email, student.fullName, course?.name || batch.name, percent, threshold)
          .then((sent) => { if (sent) db.students.update(student._id, { shortageAlertCourseIds: [...alertedCourses, batch.courseId] }); })
          .catch((err) => console.error(`Unable to send attendance shortage email to ${student.email}:`, err.message));
      }
    }

    // Mandatory Audit trail for correction
    db.auditLogs.insert({
      _id: `log_${Date.now()}`,
      actorId: req.user!._id,
      actorName: req.user!.name,
      actorRole: req.user!.role,
      action: 'CORRECT_RECORD',
      targetType: 'AttendanceRecord',
      targetId: record._id,
      details: `Changed attendance of ${student?.fullName || record.studentId} on ${session?.date || 'session'} from '${prevStatus}' to '${status}'. Reason: ${reason || 'Teacher/Admin manual correction'}.`,
      timestamp: now,
    });

    res.json({
      message: 'Attendance record updated successfully with audit trail.',
      record: updated,
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update record: ' + err.message });
  }
});

export default router;

