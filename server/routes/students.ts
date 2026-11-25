import { Router, Response } from 'express';
import { db, StudentDoc, getStudentsInBatch } from '../db.js';
import { authenticate, authorizeRoles, AuthRequest } from '../middleware/auth.js';

const router = Router();

// Helper to calculate student attendance percentage
export function calculateStudentAttendanceStats(studentId: string) {
  const records = db.attendanceRecords.find((r) => r.studentId === studentId);
  const total = records.length;
  const present = records.filter((r) => r.status === 'present').length;
  const absent = records.filter((r) => r.status === 'absent').length;
  const late = records.filter((r) => r.status === 'late').length;
  const excused = records.filter((r) => r.status === 'excused').length;

  const settings = db.settings.findById('settings_default');
  const excludeExcused = settings?.excludeExcusedFromDenominator ?? true;
  const lateWeight = settings?.lateAttendanceWeight ?? 1.0;

  const eligible = excludeExcused ? total - excused : total;
  const attendedScore = present + late * lateWeight;
  const percentage = eligible > 0 ? Math.round((attendedScore / eligible) * 100 * 10) / 10 : 100;

  return {
    totalSessions: total,
    eligibleSessions: eligible,
    present,
    absent,
    late,
    excused,
    percentage,
  };
}

// Generate sequential student ID: STU-2026-001...
function generateNextStudentId(): string {
  const year = new Date().getFullYear();
  const all = db.students.find();
  const prefix = `STU-${year}-`;
  let maxSeq = 0;
  for (const s of all) {
    if (s.studentId.startsWith(prefix)) {
      const num = parseInt(s.studentId.replace(prefix, ''), 10);
      if (!isNaN(num) && num > maxSeq) {
        maxSeq = num;
      }
    }
  }
  return `${prefix}${String(maxSeq + 1).padStart(3, '0')}`;
}

// GET /api/students
router.get('/', authenticate, (req: AuthRequest, res: Response) => {
  const { search, batchId, courseId, status, page = '1', limit = '10' } = req.query;

  let list = db.students.find();

  if (req.user?.role === 'student') {
    const linked = db.students.find((s) => s.studentId === req.user?.studentId).map((s) => s._id);
    list = list.filter((student) => linked.includes(student._id));
  }

  // Teachers only see students enrolled in their assigned batches.
  if (req.user?.role === 'teacher') {
    const teacherBatches = db.batches.find((b) => b.teacherId === req.user?._id).map((b) => b._id);
    const allowedIds = new Set(teacherBatches.flatMap((id) => getStudentsInBatch(id).map((student) => student._id)));
    list = list.filter((s) => allowedIds.has(s._id));
  }

  if (batchId) {
    const inBatch = new Set(getStudentsInBatch(String(batchId)).map((student) => student._id));
    list = list.filter((s) => inBatch.has(s._id));
  }

  if (courseId) {
    list = list.filter((s) => s.courseId === courseId);
  }

  if (status && status !== 'all') {
    list = list.filter((s) => s.status === status);
  }

  if (search) {
    const q = String(search).toLowerCase().trim();
    list = list.filter(
      (s) =>
        s.fullName.toLowerCase().includes(q) ||
        s.studentId.toLowerCase().includes(q) ||
        s.phone.includes(q) ||
        (s.email && s.email.toLowerCase().includes(q))
    );
  }

  // Enrich with course and batch names and stats
  const enriched = list.map((s) => {
    const batch = db.batches.findById(s.batchId);
    const course = db.courses.findById(s.courseId);
    const stats = calculateStudentAttendanceStats(s._id);
    return {
      ...s,
      batchName: batch?.name || 'Unassigned',
      batchCode: batch?.code || '',
      courseName: course?.name || 'Unassigned',
      stats,
    };
  });

  // Sort by studentId ascending
  enriched.sort((a, b) => a.studentId.localeCompare(b.studentId));

  const pageNum = Math.max(1, parseInt(String(page), 10));
  const limitNum = Math.max(1, parseInt(String(limit), 10));
  const total = enriched.length;
  const paginated = enriched.slice((pageNum - 1) * limitNum, pageNum * limitNum);

  res.json({
    students: paginated,
    total,
    page: pageNum,
    totalPages: Math.ceil(total / limitNum),
  });
});

// GET /api/students/me/attendance — private student dashboard data.
router.get('/me/attendance', authenticate, authorizeRoles('student'), (req: AuthRequest, res: Response) => {
  const student = db.students.findOne((s) => s.studentId === req.user?.studentId);
  if (!student) {
    res.status(404).json({ error: 'No student profile is linked to this login.' });
    return;
  }
  const stats = calculateStudentAttendanceStats(student._id);
  const defaultThreshold = db.settings.findById('settings_default')?.lowAttendanceThreshold ?? 75;
  const batch = db.batches.findById(student.batchId);
  const course = batch ? db.courses.findById(batch.courseId) : null;
  const records = db.attendanceRecords.find((r) => r.studentId === student._id);
  const history = records.map((record) => {
    const session = db.attendanceSessions.findById(record.sessionId);
    const marker = db.users.findById(record.markedBy);
    return { ...record, date: session?.date || '', sessionTitle: session?.sessionTitle || '', markedByName: marker?.name || 'Faculty' };
  }).sort((a, b) => b.date.localeCompare(a.date));
  const activeEnrollments = db.enrollments.find((enrollment) => enrollment.studentId === student._id && enrollment.status === 'active');
  const studentBatches = activeEnrollments.length
    ? activeEnrollments.map((enrollment) => db.batches.findById(enrollment.batchId)).filter((value): value is NonNullable<typeof value> => Boolean(value))
    : batch ? [batch] : [];
  const courseIds = Array.from(new Set(studentBatches.map((item) => item.courseId)));
  const subjects = courseIds.map((courseId) => {
    const subject = db.courses.findById(courseId);
    if (!subject) return null;
    const subjectBatchIds = new Set(studentBatches.filter((item) => item.courseId === courseId).map((item) => item._id));
    const subjectSessions = db.attendanceSessions.find((session) => subjectBatchIds.has(session.batchId));
    const subjectSessionIds = new Set(subjectSessions.map((session) => session._id));
    const subjectRecords = records.filter((record) => subjectSessionIds.has(record.sessionId));
    const leaveCount = subjectRecords.filter((record) => record.status === 'excused').length;
    const denominator = db.settings.findById('settings_default')?.excludeExcusedFromDenominator ? subjectRecords.length - leaveCount : subjectRecords.length;
    const presentCount = subjectRecords.filter((record) => record.status === 'present').length;
    const lateCount = subjectRecords.filter((record) => record.status === 'late').length;
    const threshold = subject.minAttendancePct ?? defaultThreshold;
    const percentage = denominator ? Math.round(((presentCount + lateCount) / denominator) * 1000) / 10 : 100;
    return {
      _id: subject._id, name: subject.name, code: subject.code, percentage,
      totalSessions: subjectRecords.length, present: presentCount,
      absent: subjectRecords.filter((record) => record.status === 'absent').length,
      belowMinimum: subjectRecords.length > 0 && percentage < threshold,
      threshold,
      absentDates: history.filter((record) => subjectSessionIds.has(record.sessionId) && record.status === 'absent').map((record) => record.date),
    };
  }).filter(Boolean);
  const threshold = subjects.length ? Math.min(...subjects.map((subject: any) => subject.threshold)) : defaultThreshold;
  const sessions = db.attendanceSessions.find((session) => studentBatches.some((item) => item._id === session.batchId));
  const months = new Map<string, { present: number; absent: number; late: number; excused: number; total: number }>();
  for (const record of history) {
    if (!record.date) continue;
    const month = record.date.slice(0, 7);
    const item = months.get(month) || { present: 0, absent: 0, late: 0, excused: 0, total: 0 };
    item.total++;
    if (record.status === 'present') item.present++;
    if (record.status === 'absent') item.absent++;
    if (record.status === 'late') item.late++;
    if (record.status === 'excused') item.excused++;
    months.set(month, item);
  }
  const monthlyBreakdown = Array.from(months, ([month, values]) => ({ month, ...values, rate: values.total ? Math.round(((values.present + values.late) / values.total) * 100) : 0 })).sort((a, b) => b.month.localeCompare(a.month));
  res.json({ student: { ...student, batchName: batch?.name || '', courseName: course?.name || '' }, stats, threshold, monthlyBreakdown, history, subjects, absentDates: history.filter((record) => record.status === 'absent').map((record) => record.date), sessionsCount: sessions.length });
});

// GET /api/students/:id
router.get('/:id', authenticate, (req: AuthRequest, res: Response) => {
  const student = db.students.findById(req.params.id);
  if (!student) {
    res.status(404).json({ error: 'Student not found.' });
    return;
  }

  if (req.user?.role === 'student' && student.studentId !== req.user.studentId) {
    res.status(403).json({ error: 'Students can only view their own profile.' });
    return;
  }

  if (req.user?.role === 'teacher') {
    const permittedBatches = db.batches.find((batch) => batch.teacherId === req.user?._id).map((batch) => batch._id);
    const canView = permittedBatches.some((batchId) => getStudentsInBatch(batchId).some((item) => item._id === student._id));
    if (!canView) {
      res.status(403).json({ error: 'Access denied: this student is not in one of your classes.' });
      return;
    }
  }

  const batch = db.batches.findById(student.batchId);
  const course = db.courses.findById(student.courseId);
  const stats = calculateStudentAttendanceStats(student._id);

  // Get attendance history
  const records = db.attendanceRecords
    .find((r) => r.studentId === student._id)
    .map((r) => {
      const session = db.attendanceSessions.findById(r.sessionId);
      const b = db.batches.findById(r.batchId);
      const marker = db.users.findById(r.markedBy);
      return {
        ...r,
        sessionDate: session?.date || '',
        sessionTitle: session?.sessionTitle || '',
        batchName: b?.name || '',
        markedByName: marker?.name || 'Faculty',
      };
    })
    .sort((a, b) => b.sessionDate.localeCompare(a.sessionDate));

  res.json({
    student: {
      ...student,
      batchName: batch?.name || 'Unassigned',
      batchCode: batch?.code || '',
      courseName: course?.name || 'Unassigned',
      stats,
      history: records,
    },
  });
});

// POST /api/students
router.post('/', authenticate, authorizeRoles('admin'), (req: AuthRequest, res: Response) => {
  try {
    const {
      fullName,
      studentId: customStudentId,
      gender,
      dob,
      phone,
      email,
      parentName,
      parentPhone,
      address,
      admissionDate,
      courseId,
      batchId,
    } = req.body;

    if (!fullName || !phone || !batchId || !courseId) {
      res.status(400).json({ error: 'Full name, phone, course, and batch are required.' });
      return;
    }

    const assignedBatch = db.batches.findById(batchId);
    if (!assignedBatch) {
      res.status(400).json({ error: 'Selected batch does not exist.' });
      return;
    }

    const assignedCourse = db.courses.findById(courseId);
    if (!assignedCourse) {
      res.status(400).json({ error: 'Selected course does not exist.' });
      return;
    }

    let finalStudentId = customStudentId?.trim();
    if (finalStudentId) {
      // Check duplicate
      const existing = db.students.findOne((s) => s.studentId.toUpperCase() === finalStudentId.toUpperCase());
      if (existing) {
        res.status(400).json({ error: `Student ID "${finalStudentId}" already exists.` });
        return;
      }
    } else {
      finalStudentId = generateNextStudentId();
    }

    const now = new Date().toISOString();
    const newStudent = db.students.insert({
      _id: `stu_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      studentId: finalStudentId,
      fullName: fullName.trim(),
      gender: gender || undefined,
      dob: dob || undefined,
      phone: phone.trim(),
      email: email ? email.trim() : undefined,
      parentName: parentName ? parentName.trim() : undefined,
      parentPhone: parentPhone ? parentPhone.trim() : undefined,
      address: address ? address.trim() : undefined,
      admissionDate: admissionDate || now.split('T')[0],
      courseId,
      batchId,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });

    // Create enrollment record
    db.enrollments.insert({
      _id: `enr_${newStudent._id}_${batchId}`,
      studentId: newStudent._id,
      batchId,
      startDate: newStudent.admissionDate,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });

    // Audit log
    db.auditLogs.insert({
      _id: `log_${Date.now()}`,
      actorId: req.user!._id,
      actorName: req.user!.name,
      actorRole: req.user!.role,
      action: 'ADD_STUDENT',
      targetType: 'Student',
      targetId: newStudent._id,
      details: `Enrolled new student ${newStudent.fullName} (${newStudent.studentId}) into ${assignedBatch.name}.`,
      timestamp: now,
    });

    res.status(201).json({
      message: 'Student registered and enrolled successfully.',
      student: newStudent,
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to create student: ' + err.message });
  }
});

// PATCH /api/students/:id
router.patch('/:id', authenticate, authorizeRoles('admin'), (req: AuthRequest, res: Response) => {
  try {
    const student = db.students.findById(req.params.id);
    if (!student) {
      res.status(404).json({ error: 'Student not found.' });
      return;
    }

    const {
      fullName,
      gender,
      dob,
      phone,
      email,
      parentName,
      parentPhone,
      address,
      courseId,
      batchId,
      status,
    } = req.body;

    const oldBatchId = student.batchId;
    const now = new Date().toISOString();

    // If batch changed, preserve attendance history and update enrollments
    if (batchId && batchId !== oldBatchId) {
      const oldEnrollment = db.enrollments.findOne(
        (e) => e.studentId === student._id && e.batchId === oldBatchId && e.status === 'active'
      );
      if (oldEnrollment) {
        db.enrollments.update(oldEnrollment._id, {
          status: 'transferred',
          endDate: now.split('T')[0],
        });
      }

      const targetEnrollment = db.enrollments.findOne((e) => e.studentId === student._id && e.batchId === batchId);
      if (targetEnrollment) {
        db.enrollments.update(targetEnrollment._id, { startDate: now.split('T')[0], endDate: '', status: 'active' });
      } else {
        db.enrollments.insert({
          _id: `enr_${student._id}_${batchId}`,
          studentId: student._id,
          batchId,
          startDate: now.split('T')[0],
          status: 'active',
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    const updated = db.students.update(student._id, {
      fullName: fullName?.trim() ?? student.fullName,
      gender: gender ?? student.gender,
      dob: dob ?? student.dob,
      phone: phone?.trim() ?? student.phone,
      email: email?.trim() ?? student.email,
      parentName: parentName?.trim() ?? student.parentName,
      parentPhone: parentPhone?.trim() ?? student.parentPhone,
      address: address?.trim() ?? student.address,
      courseId: courseId ?? student.courseId,
      batchId: batchId ?? student.batchId,
      status: status ?? student.status,
    });

    db.auditLogs.insert({
      _id: `log_${Date.now()}`,
      actorId: req.user!._id,
      actorName: req.user!.name,
      actorRole: req.user!.role,
      action: 'UPDATE_STUDENT',
      targetType: 'Student',
      targetId: student._id,
      details: `Updated details for ${student.fullName} (${student.studentId}). Batch changed: ${oldBatchId !== batchId}`,
      timestamp: now,
    });

    res.json({ message: 'Student updated successfully.', student: updated });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update student: ' + err.message });
  }
});

// PATCH /api/students/:id/archive (Soft deletion to preserve historical attendance)
router.patch('/:id/archive', authenticate, authorizeRoles('admin'), (req: AuthRequest, res: Response) => {
  const student = db.students.findById(req.params.id);
  if (!student) {
    res.status(404).json({ error: 'Student not found.' });
    return;
  }

  const newStatus = student.status === 'archived' ? 'active' : 'archived';
  const updated = db.students.update(student._id, { status: newStatus });

  db.auditLogs.insert({
    _id: `log_${Date.now()}`,
    actorId: req.user!._id,
    actorName: req.user!.name,
    actorRole: req.user!.role,
    action: newStatus === 'archived' ? 'ARCHIVE_STUDENT' : 'UNARCHIVE_STUDENT',
    targetType: 'Student',
    targetId: student._id,
    details: `${newStatus === 'archived' ? 'Archived' : 'Restored'} student ${student.fullName} (${student.studentId}).`,
    timestamp: new Date().toISOString(),
  });

  res.json({
    message: `Student status set to ${newStatus}.`,
    student: updated,
  });
});

// POST /api/students/import (Bulk CSV import)
router.post('/import', authenticate, authorizeRoles('admin'), (req: AuthRequest, res: Response) => {
  try {
    const { studentsData } = req.body;
    if (!Array.isArray(studentsData) || studentsData.length === 0) {
      res.status(400).json({ error: 'Please provide valid students array from CSV.' });
      return;
    }

    const imported: StudentDoc[] = [];
    const errors: string[] = [];
    const now = new Date().toISOString();

    for (let i = 0; i < studentsData.length; i++) {
      const row = studentsData[i];
      const fullName = row.fullName || row['Full Name'] || row.name;
      const phone = row.phone || row['Phone'] || row['Phone Number'];
      const batchCode = row.batchCode || row['Batch Code'] || row['Batch'];
      const courseCode = row.courseCode || row['Course Code'] || row['Course'];
      const email = row.email || row['Email'];
      const parentName = row.parentName || row['Parent Name'];
      const parentPhone = row.parentPhone || row['Parent Phone'];
      const customId = row.studentId || row['Student ID'];

      if (!fullName || !phone) {
        errors.push(`Row ${i + 1}: Name and phone are required.`);
        continue;
      }

      // Find batch or assign first active batch
      let targetBatch = batchCode
        ? db.batches.findOne((b) => b.code.toLowerCase() === String(batchCode).toLowerCase() || b.name.toLowerCase() === String(batchCode).toLowerCase())
        : null;
      if (!targetBatch) {
        targetBatch = db.batches.findOne((b) => b.status === 'active') || db.batches.find()[0];
      }

      if (!targetBatch) {
        errors.push(`Row ${i + 1}: No batch available.`);
        continue;
      }

      let targetStudentId = customId ? String(customId).trim() : generateNextStudentId();
      // Ensure unique
      if (db.students.findOne((s) => s.studentId === targetStudentId)) {
        targetStudentId = generateNextStudentId();
      }

      const newStudent = db.students.insert({
        _id: `stu_imp_${Date.now()}_${i}`,
        studentId: targetStudentId,
        fullName: String(fullName).trim(),
        phone: String(phone).trim(),
        email: email ? String(email).trim() : undefined,
        parentName: parentName ? String(parentName).trim() : undefined,
        parentPhone: parentPhone ? String(parentPhone).trim() : undefined,
        admissionDate: now.split('T')[0],
        courseId: targetBatch.courseId,
        batchId: targetBatch._id,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });

      db.enrollments.insert({
        _id: `enr_${newStudent._id}_${targetBatch._id}`,
        studentId: newStudent._id,
        batchId: targetBatch._id,
        startDate: newStudent.admissionDate,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });

      imported.push(newStudent);
    }

    db.auditLogs.insert({
      _id: `log_${Date.now()}`,
      actorId: req.user!._id,
      actorName: req.user!.name,
      actorRole: req.user!.role,
      action: 'BULK_IMPORT_STUDENTS',
      targetType: 'Student',
      targetId: 'multiple',
      details: `Imported ${imported.length} students via CSV.`,
      timestamp: now,
    });

    res.json({
      message: `Successfully imported ${imported.length} students.`,
      importedCount: imported.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Import failed: ' + err.message });
  }
});

// GET /api/students/export (CSV export)
router.get('/export/csv', authenticate, (req: AuthRequest, res: Response) => {
  const { batchId } = req.query;
  let list = db.students.find((s) => s.status !== 'archived');
  if (req.user?.role === 'student') {
    list = list.filter((student) => student.studentId === req.user?.studentId);
  }
  if (req.user?.role === 'teacher') {
    const allowed = new Set(db.batches.find((batch) => batch.teacherId === req.user?._id).flatMap((batch) => getStudentsInBatch(batch._id).map((student) => student._id)));
    list = list.filter((student) => allowed.has(student._id));
  }
  if (batchId) {
    list = list.filter((s) => s.batchId === batchId);
  }

  const headers = [
    'Student ID',
    'Full Name',
    'Phone',
    'Email',
    'Parent Name',
    'Parent Phone',
    'Course',
    'Batch',
    'Admission Date',
    'Total Sessions',
    'Present',
    'Absent',
    'Late',
    'Attendance %',
  ];

  const rows = list.map((s) => {
    const b = db.batches.findById(s.batchId);
    const c = db.courses.findById(s.courseId);
    const stats = calculateStudentAttendanceStats(s._id);
    return [
      `"${s.studentId}"`,
      `"${s.fullName.replace(/"/g, '""')}"`,
      `"${s.phone}"`,
      `"${s.email || ''}"`,
      `"${s.parentName || ''}"`,
      `"${s.parentPhone || ''}"`,
      `"${c?.name || ''}"`,
      `"${b?.name || ''}"`,
      `"${s.admissionDate}"`,
      stats.totalSessions,
      stats.present,
      stats.absent,
      stats.late,
      `"${stats.percentage}%"`,
    ].join(',');
  });

  const csvContent = [headers.join(','), ...rows].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="students_export_${Date.now()}.csv"`);
  res.send(csvContent);
});

export default router;
