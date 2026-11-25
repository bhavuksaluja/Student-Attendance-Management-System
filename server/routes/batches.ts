import { Router, Response } from 'express';
import { db, getStudentsInBatch } from '../db.js';
import { authenticate, authorizeRoles, AuthRequest } from '../middleware/auth.js';

const router = Router();

// ================= Courses =================
router.get(['/courses', '/subjects'], authenticate, (req: AuthRequest, res: Response) => {
  const courses = db.courses.find().map((c) => {
    const batchCount = db.batches.count((b) => b.courseId === c._id && b.status === 'active');
    const courseBatchIds = new Set(db.batches.find((batch) => batch.courseId === c._id && batch.status === 'active').map((batch) => batch._id));
    const studentCount = new Set(Array.from(courseBatchIds).flatMap((batchId) => getStudentsInBatch(batchId).map((student) => student._id))).size;
    return {
      ...c,
      batchCount,
      studentCount,
    };
  });
  res.json({ courses });
});

router.post(['/courses', '/subjects'], authenticate, authorizeRoles('admin'), (req: AuthRequest, res: Response) => {
  try {
    const { name, code, description, department, semester, minAttendancePct } = req.body;
    if (!name || !code) {
      res.status(400).json({ error: 'Course name and course code are required.' });
      return;
    }

    const cleanCode = code.trim().toUpperCase();
    const existing = db.courses.findOne((c) => c.code.toUpperCase() === cleanCode);
    if (existing) {
      res.status(400).json({ error: `Course with code "${cleanCode}" already exists.` });
      return;
    }

    const now = new Date().toISOString();
    const newCourse = db.courses.insert({
      _id: `crs_${Date.now()}`,
      name: name.trim(),
      code: cleanCode,
      description: description ? description.trim() : undefined,
      department: department ? String(department).trim() : 'General',
      semester: semester ? String(semester).trim() : '1',
      minAttendancePct: minAttendancePct === undefined ? 75 : Math.min(100, Math.max(0, Number(minAttendancePct))),
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });

    db.auditLogs.insert({
      _id: `log_${Date.now()}`,
      actorId: req.user!._id,
      actorName: req.user!.name,
      actorRole: req.user!.role,
      action: 'CREATE_COURSE',
      targetType: 'Course',
      targetId: newCourse._id,
      details: `Created new course: ${newCourse.name} (${newCourse.code}).`,
      timestamp: now,
    });

    res.status(201).json({ message: 'Course created successfully.', course: newCourse });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to create course: ' + err.message });
  }
});

router.put(['/courses/:id', '/subjects/:id'], authenticate, authorizeRoles('admin'), (req: AuthRequest, res: Response) => {
  const course = db.courses.findById(req.params.id);
  if (!course) {
    res.status(404).json({ error: 'Subject not found.' });
    return;
  }
  const { name, code, description, department, semester, minAttendancePct, status } = req.body;
  const nextCode = code === undefined ? course.code : String(code).trim().toUpperCase();
  const duplicate = db.courses.findOne((item) => item._id !== course._id && item.code.toUpperCase() === nextCode);
  if (duplicate) {
    res.status(400).json({ error: `Subject code '${nextCode}' is already in use.` });
    return;
  }
  const updated = db.courses.update(course._id, {
    name: name === undefined ? course.name : String(name).trim(),
    code: nextCode,
    description: description === undefined ? course.description : String(description).trim(),
    department: department === undefined ? course.department : String(department).trim(),
    semester: semester === undefined ? course.semester : String(semester).trim(),
    minAttendancePct: minAttendancePct === undefined ? course.minAttendancePct : Math.min(100, Math.max(0, Number(minAttendancePct))),
    status: status ?? course.status,
  });
  const now = new Date().toISOString();
  db.auditLogs.insert({ _id: `log_${Date.now()}`, actorId: req.user!._id, actorName: req.user!.name, actorRole: req.user!.role, action: 'UPDATE_SUBJECT', targetType: 'Subject', targetId: course._id, details: `Updated subject ${updated?.name || course.name} (${nextCode}).`, timestamp: now });
  res.json({ subject: updated, message: 'Subject updated successfully.' });
});

// ================= Batches =================
// GET /api/batches
router.get('/batches', authenticate, (req: AuthRequest, res: Response) => {
  let list = db.batches.find();

  if (req.user?.role === 'teacher') {
    list = list.filter((b) => b.teacherId === req.user?._id);
  }
  if (req.user?.role === 'student') {
    const student = db.students.findOne((item) => item.studentId === req.user?.studentId);
    const enrollmentBatchIds = student ? db.enrollments.find((enrollment) => enrollment.studentId === student._id && enrollment.status === 'active').map((enrollment) => enrollment.batchId) : [];
    const allowedBatchIds = enrollmentBatchIds.length ? enrollmentBatchIds : student ? [student.batchId] : [];
    list = list.filter((batch) => allowedBatchIds.includes(batch._id));
  }

  const enriched = list.map((b) => {
    const course = db.courses.findById(b.courseId);
    const teacher = db.users.findById(b.teacherId);
    const studentCount = getStudentsInBatch(b._id).length;
    const sessionCount = db.attendanceSessions.count((s) => s.batchId === b._id);
    return {
      ...b,
      courseName: course?.name || 'Unassigned Course',
      courseCode: course?.code || '',
      teacherName: teacher?.name || 'Unassigned Teacher',
      teacherEmail: teacher?.email || '',
      studentCount,
      sessionCount,
    };
  });

  res.json({ batches: enriched });
});

// GET /api/batches/:id
router.get('/batches/:id', authenticate, (req: AuthRequest, res: Response) => {
  const batch = db.batches.findById(req.params.id);
  if (!batch) {
    res.status(404).json({ error: 'Batch not found.' });
    return;
  }

  if (req.user?.role === 'teacher' && batch.teacherId !== req.user._id) {
    res.status(403).json({ error: 'Access denied: this batch is not assigned to you.' });
    return;
  }

  const course = db.courses.findById(batch.courseId);
  const teacher = db.users.findById(batch.teacherId);
  const enrolledStudents = getStudentsInBatch(batch._id)
    .map((s) => ({
      _id: s._id,
      studentId: s.studentId,
      fullName: s.fullName,
      phone: s.phone,
      email: s.email,
    }));

  res.json({
    batch: {
      ...batch,
      courseName: course?.name || '',
      teacherName: teacher?.name || 'Unassigned',
      teacherEmail: teacher?.email || '',
      students: enrolledStudents,
      studentCount: enrolledStudents.length,
    },
  });
});

// GET /api/batches/:id/students
router.get('/batches/:id/students', authenticate, (req: AuthRequest, res: Response) => {
  const batch = db.batches.findById(req.params.id);
  if (!batch) {
    res.status(404).json({ error: 'Batch not found.' });
    return;
  }

  // Teacher authorization check: can only view their own batch unless admin
  if (req.user?.role === 'teacher' && batch.teacherId !== req.user._id) {
    res.status(403).json({ error: 'Access denied: You are not the assigned teacher for this batch.' });
    return;
  }

  const students = getStudentsInBatch(batch._id)
    .map((s) => ({
      _id: s._id,
      studentId: s.studentId,
      fullName: s.fullName,
      phone: s.phone,
      email: s.email,
      parentPhone: s.parentPhone,
      status: s.status,
    }))
    .sort((a, b) => a.studentId.localeCompare(b.studentId));

  res.json({ students });
});

// POST /api/batches
router.post('/batches', authenticate, authorizeRoles('admin'), (req: AuthRequest, res: Response) => {
  try {
    const {
      name,
      code,
      courseId,
      teacherId,
      startDate,
      endDate,
      classDays,
      startTime,
      endTime,
      room,
    } = req.body;

    if (!name || !code || !courseId || !teacherId || !startTime || !endTime) {
      res.status(400).json({ error: 'Batch name, code, course, teacher, and schedule times are required.' });
      return;
    }

    const cleanCode = code.trim().toUpperCase();
    const existing = db.batches.findOne((b) => b.code.toUpperCase() === cleanCode);
    if (existing) {
      res.status(400).json({ error: `Batch with code "${cleanCode}" already exists.` });
      return;
    }

    const teacher = db.users.findById(teacherId);
    if (!teacher || teacher.role !== 'teacher') {
      res.status(400).json({ error: 'Assigned user must be a valid faculty/teacher.' });
      return;
    }

    const course = db.courses.findById(courseId);
    if (!course) {
      res.status(400).json({ error: 'Selected course does not exist.' });
      return;
    }

    const now = new Date().toISOString();
    const newBatch = db.batches.insert({
      _id: `btc_${Date.now()}`,
      name: name.trim(),
      code: cleanCode,
      courseId,
      teacherId,
      startDate: startDate || now.split('T')[0],
      endDate: endDate || '2026-12-31',
      classDays: Array.isArray(classDays) && classDays.length > 0 ? classDays : ['Mon', 'Wed', 'Fri'],
      startTime,
      endTime,
      room: room ? room.trim() : undefined,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });

    db.auditLogs.insert({
      _id: `log_${Date.now()}`,
      actorId: req.user!._id,
      actorName: req.user!.name,
      actorRole: req.user!.role,
      action: 'CREATE_BATCH',
      targetType: 'Batch',
      targetId: newBatch._id,
      details: `Created batch: ${newBatch.name} (${newBatch.code}) assigned to ${teacher.name}.`,
      timestamp: now,
    });

    res.status(201).json({ message: 'Batch created successfully.', batch: newBatch });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to create batch: ' + err.message });
  }
});

// PATCH /api/batches/:id
router.patch('/batches/:id', authenticate, authorizeRoles('admin'), (req: AuthRequest, res: Response) => {
  try {
    const batch = db.batches.findById(req.params.id);
    if (!batch) {
      res.status(404).json({ error: 'Batch not found.' });
      return;
    }

    const {
      name,
      courseId,
      teacherId,
      startDate,
      endDate,
      classDays,
      startTime,
      endTime,
      room,
      status,
    } = req.body;

    const oldTeacherId = batch.teacherId;

    const updated = db.batches.update(batch._id, {
      name: name?.trim() ?? batch.name,
      courseId: courseId ?? batch.courseId,
      teacherId: teacherId ?? batch.teacherId,
      startDate: startDate ?? batch.startDate,
      endDate: endDate ?? batch.endDate,
      classDays: classDays ?? batch.classDays,
      startTime: startTime ?? batch.startTime,
      endTime: endTime ?? batch.endTime,
      room: room?.trim() ?? batch.room,
      status: status ?? batch.status,
    });

    db.auditLogs.insert({
      _id: `log_${Date.now()}`,
      actorId: req.user!._id,
      actorName: req.user!.name,
      actorRole: req.user!.role,
      action: 'UPDATE_BATCH',
      targetType: 'Batch',
      targetId: batch._id,
      details: `Updated batch ${batch.name}. Faculty reassigned: ${oldTeacherId !== teacherId}`,
      timestamp: new Date().toISOString(),
    });

    res.json({ message: 'Batch updated successfully.', batch: updated });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update batch: ' + err.message });
  }
});

function addSubjectEnrollment(courseId: string, row: any) {
  const rawStudentId = String(row.studentId || row['Student ID'] || row.studentCode || '').trim();
  if (!rawStudentId) throw new Error('Student ID is required.');
  const student = db.students.findOne((s) => s._id === rawStudentId || s.studentId.toLowerCase() === rawStudentId.toLowerCase());
  if (!student) throw new Error(`Student '${rawStudentId}' was not found.`);

  const requestedBatch = String(row.batchCode || row['Batch Code'] || row.batchId || '').trim();
  let batch = requestedBatch
    ? db.batches.findOne((b) => b.courseId === courseId && (b._id === requestedBatch || b.code.toLowerCase() === requestedBatch.toLowerCase()) && b.status === 'active')
    : db.batches.findOne((b) => b._id === student.batchId && b.courseId === courseId && b.status === 'active');
  if (!batch && !requestedBatch) batch = db.batches.findOne((b) => b.courseId === courseId && b.status === 'active');
  if (!batch) throw new Error('Select an active class batch for this subject.');

  const existingSubjectEnrollment = db.enrollments.findOne((enrollment) =>
    enrollment.studentId === student._id && enrollment.status === 'active' && db.batches.findById(enrollment.batchId)?.courseId === courseId
  );
  if (existingSubjectEnrollment) return { studentId: student.studentId, batch: batch.name, alreadyEnrolled: true };
  const existing = db.enrollments.findOne((e) => e.studentId === student._id && e.batchId === batch!._id);
  const now = new Date().toISOString();
  const enrollment = existing
    ? db.enrollments.update(existing._id, { startDate: now.slice(0, 10), endDate: undefined, status: 'active' })
    : db.enrollments.insert({
        _id: `enr_${student._id}_${batch._id}`,
        studentId: student._id,
        batchId: batch._id,
        startDate: now.slice(0, 10),
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
  return { studentId: student.studentId, batch: batch.name, enrollment };
}

router.post('/subjects/:id/enroll', authenticate, authorizeRoles('admin'), (req: AuthRequest, res: Response) => {
  const course = db.courses.findById(req.params.id);
  if (!course) {
    res.status(404).json({ error: 'Subject not found.' });
    return;
  }
  try {
    res.status(201).json({ enrollment: addSubjectEnrollment(course._id, req.body) });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/subjects/:id/enroll/csv', authenticate, authorizeRoles('admin'), (req: AuthRequest, res: Response) => {
  const course = db.courses.findById(req.params.id);
  if (!course) {
    res.status(404).json({ error: 'Subject not found.' });
    return;
  }
  const rows = req.body.studentsData;
  if (!Array.isArray(rows) || rows.length === 0) {
    res.status(400).json({ error: 'Provide student rows parsed from a CSV file.' });
    return;
  }
  const enrolled: any[] = [];
  const errors: string[] = [];
  rows.forEach((row: any, index: number) => {
    try { enrolled.push(addSubjectEnrollment(course._id, row)); }
    catch (err: any) { errors.push(`Row ${index + 1}: ${err.message}`); }
  });
  res.json({ enrolledCount: enrolled.filter((item) => !item.alreadyEnrolled).length, enrolled, errors });
});

export default router;
