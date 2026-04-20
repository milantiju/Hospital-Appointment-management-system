const express = require('express');
const path = require('path');
const mysql = require('mysql2/promise');

const app = express();
const PORT = 3000;

// DB connection (use exactly these credentials)
const db = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: 'root',
  database: 'hospital_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  dateStrings: true
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

function ok(res, data) {
  return res.json({ ok: true, data });
}

function fail(res, message, status = 400, details) {
  return res.status(status).json({ ok: false, message, details });
}

function isValidSeverity(sev) {
  return ['Low', 'Medium', 'High', 'Critical'].includes(sev);
}

function isValidGender(g) {
  return ['Male', 'Female', 'Other'].includes(g);
}

function isISODate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function isTimeHHMMSS(s) {
  return typeof s === 'string' && /^\d{2}:\d{2}(:\d{2})?$/.test(s);
}

async function queryOne(sql, params = []) {
  const [rows] = await db.query(sql, params);
  return rows?.[0] ?? null;
}

// ---------- Dashboard ----------
app.get('/api/dashboard/stats', async (req, res) => {
  try {
    const [patients, doctors, appts, depts] = await Promise.all([
      queryOne('SELECT COUNT(*) AS total FROM patient'),
      queryOne('SELECT COUNT(*) AS total FROM doctor'),
      queryOne('SELECT COUNT(*) AS total FROM appointment'),
      queryOne('SELECT COUNT(*) AS total FROM department')
    ]);

    return ok(res, {
      totalPatients: patients.total,
      totalDoctors: doctors.total,
      totalAppointments: appts.total,
      totalDepartments: depts.total
    });
  } catch (err) {
    return fail(res, 'Failed to load dashboard stats.', 500, err.message);
  }
});

app.get('/api/dashboard/severity', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT severity_level, COUNT(*) AS total
       FROM appointment
       GROUP BY severity_level`
    );

    const base = { Low: 0, Medium: 0, High: 0, Critical: 0 };
    for (const r of rows) {
      if (base[r.severity_level] !== undefined) base[r.severity_level] = r.total;
    }
    return ok(res, base);
  } catch (err) {
    return fail(res, 'Failed to load severity counts.', 500, err.message);
  }
});

app.get('/api/dashboard/recent', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT *
       FROM vw_appointment_summary
       ORDER BY date DESC, time DESC
       LIMIT 5`
    );
    return ok(res, rows);
  } catch (err) {
    return fail(res, 'Failed to load recent appointments.', 500, err.message);
  }
});

// ---------- Departments ----------
app.get('/api/departments', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT dept_id, dept_name, capacity
       FROM department
       ORDER BY dept_name`
    );
    return ok(res, rows);
  } catch (err) {
    return fail(res, 'Failed to load departments.', 500, err.message);
  }
});

app.post('/api/departments', async (req, res) => {
  try {
    const { dept_name, capacity } = req.body;
    if (!dept_name || typeof dept_name !== 'string') {
      return fail(res, 'Department name is required.');
    }
    const capNum = Number(capacity);
    if (!Number.isInteger(capNum) || capNum < 0) {
      return fail(res, 'Capacity must be a non-negative integer.');
    }

    const [result] = await db.execute(
      `INSERT INTO department (dept_name, capacity)
       VALUES (?, ?)`,
      [dept_name.trim(), capNum]
    );
    return ok(res, { dept_id: result.insertId });
  } catch (err) {
    if (err?.code === 'ER_DUP_ENTRY') {
      return fail(res, 'Department name must be unique.');
    }
    return fail(res, 'Failed to add department.', 500, err.message);
  }
});

app.get('/api/departments/summary', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT
         d.dept_id,
         d.dept_name,
         d.capacity,
         COUNT(DISTINCT p.patient_id) AS patient_count,
         COUNT(DISTINCT doc.doctor_id) AS doctor_count
       FROM department d
       LEFT JOIN patient p ON p.dept_id = d.dept_id
       LEFT JOIN doctor doc ON doc.dept_id = d.dept_id
       GROUP BY d.dept_id, d.dept_name, d.capacity
       ORDER BY d.dept_name`
    );
    return ok(res, rows);
  } catch (err) {
    return fail(res, 'Failed to load department summary.', 500, err.message);
  }
});

// ---------- Patients ----------
app.get('/api/patients', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT
         patient_id,
         name,
         gender,
         dob,
         TIMESTAMPDIFF(YEAR, dob, CURDATE()) AS age,
         phone_number,
         dept_id
       FROM patient
       ORDER BY patient_id DESC`
    );
    return ok(res, rows);
  } catch (err) {
    return fail(res, 'Failed to load patients.', 500, err.message);
  }
});

app.post('/api/patients', async (req, res) => {
  try {
    const { name, gender, dob, phone_number, dept_id } = req.body;

    if (!name || typeof name !== 'string') return fail(res, 'Patient name is required.');
    if (!isValidGender(gender)) return fail(res, "Gender must be 'Male', 'Female', or 'Other'.");
    if (!isISODate(dob)) return fail(res, 'DOB must be in YYYY-MM-DD format.');
    if (!phone_number || typeof phone_number !== 'string') return fail(res, 'Phone number is required.');

    const deptNum = Number(dept_id);
    if (!Number.isInteger(deptNum) || deptNum <= 0) return fail(res, 'dept_id must be a positive integer.');

    const [result] = await db.execute(
      `INSERT INTO patient (name, gender, dob, phone_number, dept_id)
       VALUES (?, ?, ?, ?, ?)`,
      [name.trim(), gender, dob, phone_number.trim(), deptNum]
    );

    return ok(res, { patient_id: result.insertId });
  } catch (err) {
    if (err?.code === 'ER_DUP_ENTRY') {
      return fail(res, 'Phone number must be unique.');
    }
    if (err?.code === 'ER_NO_REFERENCED_ROW_2') {
      return fail(res, 'Invalid dept_id (department not found).');
    }
    return fail(res, 'Failed to add patient.', 500, err.message);
  }
});

app.put('/api/patients/:id/phone', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { phone_number } = req.body;
    if (!Number.isInteger(id) || id <= 0) return fail(res, 'Invalid patient id.');
    if (!phone_number || typeof phone_number !== 'string') return fail(res, 'phone_number is required.');

    const [result] = await db.execute(
      `UPDATE patient
       SET phone_number = ?
       WHERE patient_id = ?`,
      [phone_number.trim(), id]
    );
    if (result.affectedRows === 0) return fail(res, 'Patient not found.', 404);
    return ok(res, { updated: true });
  } catch (err) {
    if (err?.code === 'ER_DUP_ENTRY') {
      return fail(res, 'Phone number must be unique.');
    }
    return fail(res, 'Failed to update phone number.', 500, err.message);
  }
});

app.delete('/api/patients/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(res, 'Invalid patient id.');

    const [result] = await db.execute(
      `DELETE FROM patient
       WHERE patient_id = ?`,
      [id]
    );
    if (result.affectedRows === 0) return fail(res, 'Patient not found.', 404);
    return ok(res, { deleted: true });
  } catch (err) {
    if (err?.code === 'ER_ROW_IS_REFERENCED_2') {
      return fail(res, 'Cannot delete patient: there are appointments referencing this patient.');
    }
    return fail(res, 'Failed to delete patient.', 500, err.message);
  }
});

app.get('/api/patients/:id/appt-count', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(res, 'Invalid patient id.');

    const row = await queryOne('SELECT CountPatientAppointments(?) AS total', [id]);
    return ok(res, { patient_id: id, total: row?.total ?? 0 });
  } catch (err) {
    return fail(res, 'Failed to load appointment count for patient.', 500, err.message);
  }
});

// ---------- Doctors ----------
app.get('/api/doctors', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT
         doc.doctor_id,
         doc.doctor_name,
         doc.specialisation,
         doc.dept_id,
         d.dept_name
       FROM doctor doc
       JOIN department d ON d.dept_id = doc.dept_id
       ORDER BY doc.doctor_id DESC`
    );
    return ok(res, rows);
  } catch (err) {
    return fail(res, 'Failed to load doctors.', 500, err.message);
  }
});

app.post('/api/doctors', async (req, res) => {
  try {
    const { doctor_name, specialisation, dept_id } = req.body;
    if (!doctor_name || typeof doctor_name !== 'string') return fail(res, 'Doctor name is required.');
    if (!specialisation || typeof specialisation !== 'string') return fail(res, 'Specialisation is required.');
    const deptNum = Number(dept_id);
    if (!Number.isInteger(deptNum) || deptNum <= 0) return fail(res, 'dept_id must be a positive integer.');

    const [result] = await db.execute(
      `INSERT INTO doctor (doctor_name, specialisation, dept_id)
       VALUES (?, ?, ?)`,
      [doctor_name.trim(), specialisation.trim(), deptNum]
    );
    return ok(res, { doctor_id: result.insertId });
  } catch (err) {
    if (err?.code === 'ER_NO_REFERENCED_ROW_2') {
      return fail(res, 'Invalid dept_id (department not found).');
    }
    return fail(res, 'Failed to add doctor.', 500, err.message);
  }
});

app.get('/api/doctors/appt-count', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT
         d.doctor_id,
         d.doctor_name,
         COUNT(a.appointment_id) AS total_appointments
       FROM doctor d
       LEFT JOIN appointment a ON a.doctor_id = d.doctor_id
       GROUP BY d.doctor_id, d.doctor_name
       ORDER BY total_appointments DESC, d.doctor_name ASC`
    );
    return ok(res, rows);
  } catch (err) {
    return fail(res, 'Failed to load appointments per doctor.', 500, err.message);
  }
});

// ---------- Appointments ----------
app.get('/api/appointments', async (req, res) => {
  try {
    const { severity } = req.query;
    if (severity && severity !== 'All' && !isValidSeverity(severity)) {
      return fail(res, "severity must be one of: All, Low, Medium, High, Critical.");
    }

    if (severity && severity !== 'All') {
      const [rows] = await db.query(
        `SELECT *
         FROM vw_appointment_summary
         WHERE severity_level = ?
         ORDER BY date DESC, time DESC`,
        [severity]
      );
      return ok(res, rows);
    }

    const [rows] = await db.query(
      `SELECT *
       FROM vw_appointment_summary
       ORDER BY date DESC, time DESC`
    );
    return ok(res, rows);
  } catch (err) {
    return fail(res, 'Failed to load appointments.', 500, err.message);
  }
});

app.post('/api/appointments', async (req, res) => {
  try {
    const { patient_id, doctor_id, date, time, severity_level } = req.body;
    const p = Number(patient_id);
    const d = Number(doctor_id);
    if (!Number.isInteger(p) || p <= 0) return fail(res, 'patient_id must be a positive integer.');
    if (!Number.isInteger(d) || d <= 0) return fail(res, 'doctor_id must be a positive integer.');
    if (!isISODate(date)) return fail(res, 'date must be in YYYY-MM-DD format.');
    if (!isTimeHHMMSS(time)) return fail(res, 'time must be in HH:MM or HH:MM:SS format.');
    if (!isValidSeverity(severity_level)) {
      return fail(res, "severity_level must be 'Low', 'Medium', 'High', or 'Critical'.");
    }

    const [callOut] = await db.query('CALL SafeBookAppointment(?, ?, ?, ?, ?)', [
      p,
      d,
      date,
      time,
      severity_level
    ]);
    const statusRow = callOut?.[0]?.[0];
    const statusText = statusRow && typeof statusRow.status === 'string' ? statusRow.status : '';
    if (statusText.startsWith('ERROR')) {
      return fail(res, statusText.replace(/^ERROR:\s*/i, '').trim() || 'Booking was rolled back.', 400);
    }
    if (!statusText.startsWith('SUCCESS')) {
      return fail(res, 'SafeBookAppointment did not confirm success.', 500, statusText || null);
    }
    return ok(res, { booked: true });
  } catch (err) {
    return fail(res, 'Failed to book appointment (SafeBookAppointment).', 500, err.message);
  }
});

app.get('/api/appointments/log', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT log_id, appointment_id, action, log_time
       FROM appointment_log
       ORDER BY log_time DESC
       LIMIT 200`
    );
    return ok(res, rows);
  } catch (err) {
    return fail(res, 'Failed to load appointment log.', 500, err.message);
  }
});

// ---------- Fallback: SPA-ish navigation ----------
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((req, res) => fail(res, 'Not found.', 404));

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`HMDS server running at http://localhost:${PORT}`);
});

