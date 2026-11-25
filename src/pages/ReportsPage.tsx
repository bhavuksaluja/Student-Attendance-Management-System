import React, { useState, useEffect } from 'react';
import { api } from '../services/api.js';
import {
  BarChart3,
  Download,
  Printer,
  Calendar,
  Layers,
  Users,
  AlertTriangle,
  TrendingUp,
  Search,
  Filter,
} from 'lucide-react';
import toast, { Toaster } from 'react-hot-toast';

export const ReportsPage: React.FC = () => {
  const [subjects, setSubjects] = useState<any[]>([]);
  const [selectedSubjectId, setSelectedSubjectId] = useState<string>('');
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');

  const [reportData, setReportData] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);
  const [searchFilter, setSearchFilter] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState('percentage');
  const [order, setOrder] = useState<'asc' | 'desc'>('asc');

  // Fetch batches
  useEffect(() => {
    const fetchBatches = async () => {
      try {
        const res = await api.getCourses();
        setSubjects(res.courses);
        if (res.courses.length > 0) {
          setSelectedSubjectId(res.courses[0]._id);
        }
      } catch (err: any) {
        toast.error('Failed to load batches');
      }
    };
    fetchBatches();
  }, []);

  // Fetch report
  const fetchReport = async () => {
    if (!selectedSubjectId) return;
    try {
      setLoading(true);
      const params: any = {};
      if (startDate) params.from = startDate;
      if (endDate) params.to = endDate;
      params.page = String(page);
      params.sort = sort;
      params.order = order;

      const res = await api.getSubjectReport(selectedSubjectId, params);
      setReportData(res);
    } catch (err: any) {
      toast.error(err.message || 'Failed to generate report');
      setReportData(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (selectedSubjectId) {
      fetchReport();
    }
  }, [selectedSubjectId, startDate, endDate, page, sort, order]);

  const toggleSort = (key: string) => {
    setOrder(sort === key && order === 'asc' ? 'desc' : 'asc');
    setSort(key);
    setPage(1);
  };

  const handlePrint = () => {
    window.print();
  };

  const filteredStudents = (reportData?.students || []).filter((s: any) =>
    s.fullName.toLowerCase().includes(searchFilter.toLowerCase()) ||
    s.studentId.toLowerCase().includes(searchFilter.toLowerCase())
  );

  return (
    <div className="space-y-6">
      <Toaster position="top-right" />

      {/* Header & Export Actions */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-extrabold text-slate-900 tracking-tight">Attendance Reports</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Audit cohort attendance distributions, identify deficits, and export institutional summaries.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handlePrint}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg shadow-xs transition-colors"
          >
            <Printer className="w-3.5 h-3.5 text-slate-500" />
            <span>Print View</span>
          </button>

            {selectedSubjectId && (
            <a
              href={`/api/attendance/reports/export/csv?subjectId=${selectedSubjectId}${
                startDate ? `&startDate=${startDate}` : ''
              }${endDate ? `&endDate=${endDate}` : ''}`}
              download
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg shadow-xs transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Download CSV</span>
            </a>
          )}
        </div>
      </div>

      {/* Filter Parameters */}
      <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div>
          <label className="block text-xs font-bold text-slate-700 mb-1">Subject</label>
          <select
            value={selectedSubjectId}
            onChange={(e) => { setPage(1); setSelectedSubjectId(e.target.value); }}
            className="w-full text-xs py-2 px-3 border border-slate-300 rounded-lg bg-slate-50 font-medium text-slate-800"
          >
            {subjects.map((subject) => (
              <option key={subject._id} value={subject._id}>
                {subject.name} ({subject.code})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs font-bold text-slate-700 mb-1">Start Date (Optional)</label>
          <input
            type="date"
            value={startDate}
            onChange={(e) => { setPage(1); setStartDate(e.target.value); }}
            className="w-full text-xs py-2 px-3 border border-slate-300 rounded-lg bg-slate-50 text-slate-800"
          />
        </div>

        <div>
          <label className="block text-xs font-bold text-slate-700 mb-1">End Date (Optional)</label>
          <input
            type="date"
            value={endDate}
            onChange={(e) => { setPage(1); setEndDate(e.target.value); }}
            className="w-full text-xs py-2 px-3 border border-slate-300 rounded-lg bg-slate-50 text-slate-800"
          />
        </div>
      </div>

      {/* Summary KPI Strip */}
      {reportData?.subject && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-2xs">
            <p className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">Cohort</p>
            <p className="text-base font-extrabold text-slate-900 mt-1 truncate">{reportData.subject.name}</p>
            <p className="text-[11px] text-slate-400 font-mono mt-0.5">{reportData.subject.code}</p>
          </div>

          <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-2xs">
            <p className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">Enrolled Students</p>
            <p className="text-2xl font-black text-slate-900 tabular-nums mt-1">
              {reportData.summary.enrolledStudents}
            </p>
          </div>

          <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-2xs">
            <p className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">Conducted Sessions</p>
            <p className="text-2xl font-black text-slate-900 tabular-nums mt-1">
              {reportData.summary.sessions}
            </p>
          </div>

          <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-2xs">
            <p className="text-[11px] font-bold text-indigo-700 uppercase tracking-wider">Batch Average</p>
            <p className="text-2xl font-black text-indigo-700 tabular-nums mt-1">
              {(reportData.summary.averageAttendance ?? 100).toFixed(1)}%
            </p>
          </div>
        </div>
      )}

      {/* Student Comparison Table */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
        <div className="p-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <h3 className="text-sm font-bold text-slate-900">Student Attendance Comparison</h3>

          <div className="relative max-w-xs w-full">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
            <input
              type="text"
              value={searchFilter}
              onChange={(e) => setSearchFilter(e.target.value)}
              placeholder="Search student in report..."
              className="w-full text-xs pl-9 pr-3 py-1.5 border border-slate-300 rounded-lg"
            />
          </div>
        </div>

        {loading ? (
          <div className="p-12 text-center text-xs text-slate-500">Generating report data...</div>
        ) : filteredStudents.length === 0 ? (
          <div className="p-12 text-center text-xs text-slate-500">No records found for selected criteria.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 text-slate-500 uppercase tracking-wider text-[11px] font-bold border-b border-slate-200">
                <tr>
                  <th className="py-3 px-4"><button onClick={() => toggleSort('studentId')}>Student ID ↕</button></th>
                  <th className="py-3 px-4"><button onClick={() => toggleSort('fullName')}>Full Name ↕</button></th>
                  <th className="py-3 px-4 text-center"><button onClick={() => toggleSort('totalSessions')}>Sessions ↕</button></th>
                  <th className="py-3 px-4 text-center text-emerald-700">Present</th>
                  <th className="py-3 px-4 text-center text-rose-700">Absent</th>
                  <th className="py-3 px-4 text-center text-amber-700">Late</th>
                  <th className="py-3 px-4 text-center text-indigo-700">Leave</th>
                  <th className="py-3 px-4 text-right"><button onClick={() => toggleSort('percentage')}>Attendance % ↕</button></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredStudents.map((st: any) => (
                  <tr key={st._id} className="hover:bg-slate-50 transition-colors">
                    <td className="py-3 px-4 font-mono font-medium text-slate-700">{st.studentId}</td>
                    <td className="py-3 px-4 font-bold text-slate-900">
                      <span>{st.fullName}</span>
                      {st.belowMinimum && (
                        <span className="ml-2 inline-flex items-center gap-1 text-[10px] text-rose-700 bg-rose-50 px-1.5 py-0.5 rounded font-semibold">
                          <AlertTriangle className="w-3 h-3" /> Deficit
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-center tabular-nums text-slate-600">{st.totalSessions}</td>
                    <td className="py-3 px-4 text-center tabular-nums font-semibold text-emerald-700">{st.present}</td>
                    <td className="py-3 px-4 text-center tabular-nums font-semibold text-rose-700">{st.absent}</td>
                    <td className="py-3 px-4 text-center tabular-nums font-semibold text-amber-700">{st.late}</td>
                    <td className="py-3 px-4 text-center tabular-nums font-semibold text-indigo-700">{st.leave}</td>
                    <td className="py-3 px-4 text-right">
                      <span
                        className={`font-black tabular-nums ${
                          st.belowMinimum ? 'text-rose-600' : 'text-slate-900'
                        }`}
                      >
                        {st.percentage}%
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {reportData && (
          <div className="px-4 py-3 border-t border-slate-200 flex items-center justify-between text-xs text-slate-600">
            <span>Page {reportData.page || 1} of {Math.max(1, reportData.totalPages || 1)} · {reportData.total || 0} students</span>
            <div className="flex gap-2">
              <button disabled={(reportData.page || 1) <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))} className="px-3 py-1.5 border rounded disabled:opacity-40">Previous</button>
              <button disabled={(reportData.page || 1) >= (reportData.totalPages || 1)} onClick={() => setPage((value) => value + 1)} className="px-3 py-1.5 border rounded disabled:opacity-40">Next</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
