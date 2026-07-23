// ============================================================================
// EMPLOYEE LEAVE MANAGEMENT SYSTEM - SUPABASE BACKEND
// ============================================================================
// Replaces the old localStorage mock DB with real Supabase Auth + Postgres.
// Company isolation is enforced server-side via Row Level Security (RLS),
// not just by filtering in JS — see schema.sql.
// ============================================================================

// ----------------------------------------------------------------------------
// SUPABASE CLIENT
// ----------------------------------------------------------------------------
// Project URL was derived from the "ref" claim in your anon key's JWT payload.
// The anon key is meant to be public/client-side — see note in the chat reply.
const SUPABASE_URL = "https://ynecixgzccipyhwtsacg.supabase.co";
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InluZWNpeGd6Y2NpcHlod3RzYWNnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ3MzcwNjEsImV4cCI6MjEwMDMxMzA2MX0._WWGiWv5OdbbmxUCGcnAxntFr8t_SNaPaypYArCWXIA';

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

let currentUser = null; // holds the merged { ...authUser, ...profile } record
let useLocalFallback = false;
const LOCAL_DB_KEY = 'elms_local_db';
const LOCAL_SESSION_KEY = 'elms_local_session';

function getLocalDB() {
    const raw = localStorage.getItem(LOCAL_DB_KEY);
    if (!raw) return { companies: [], profiles: [], leave_requests: [] };
    try {
        return JSON.parse(raw);
    } catch {
        return { companies: [], profiles: [], leave_requests: [] };
    }
}

function saveLocalDB(db) {
    localStorage.setItem(LOCAL_DB_KEY, JSON.stringify(db));
}

function loadLocalSession() {
    const raw = localStorage.getItem(LOCAL_SESSION_KEY);
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function saveLocalSession(session) {
    localStorage.setItem(LOCAL_SESSION_KEY, JSON.stringify(session));
}

function clearLocalSession() {
    localStorage.removeItem(LOCAL_SESSION_KEY);
}

function localGenerateId(prefix = 'local') {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function localFindCompanyById(companyId) {
    const db = getLocalDB();
    return db.companies.find(company => company.id === companyId) || null;
}

function localFindCompanyByCode(companyCode) {
    const normalized = normalizeCompanyCode(companyCode);
    if (!normalized) return null;
    const db = getLocalDB();
    return db.companies.find(company => normalizeCompanyCode(company.code) === normalized) || null;
}

function localFindProfileByEmail(email) {
    const db = getLocalDB();
    return db.profiles.find(profile => profile.email.toLowerCase() === email.toLowerCase()) || null;
}

function localAuthenticate(email, password) {
    const profile = localFindProfileByEmail(email);
    return profile && profile.password === password ? profile : null;
}

function localFetchProfile(userId) {
    const db = getLocalDB();
    const data = db.profiles.find(profile => profile.id === userId);
    if (!data) return null;

    const company = localFindCompanyById(data.company_id);
    return {
        id: data.id,
        name: data.name,
        email: data.email,
        role: data.role,
        companyId: data.company_id,
        companyCode: company?.code,
        companyName: company?.name,
        casualBalance: data.casual_balance,
        sickBalance: data.sick_balance,
        earnedBalance: data.earned_balance
    };
}

function localCreateCompany(name) {
    const db = getLocalDB();
    const company = {
        id: localGenerateId('company'),
        code: `COMP-${Math.floor(Math.random() * 9000 + 1000)}`,
        name,
        created_at: new Date().toISOString()
    };
    db.companies.push(company);
    saveLocalDB(db);
    return company;
}

function localCreateProfile(profileData) {
    const db = getLocalDB();
    db.profiles.push(profileData);
    saveLocalDB(db);
    return profileData;
}

function localSeedDatabase() {
    const db = getLocalDB();
    if (db.companies.length === 0) {
        const company = {
            id: localGenerateId('company'),
            code: 'COMP-0001',
            name: 'Local Demo Co',
            created_at: new Date().toISOString()
        };
        const profile = {
            id: localGenerateId('profile'),
            name: 'Local Admin',
            email: 'admin@local.com',
            password: 'admin123',
            role: 'HR Admin',
            company_id: company.id,
            casual_balance: 12,
            sick_balance: 10,
            earned_balance: 15,
            created_at: new Date().toISOString()
        };
        db.companies.push(company);
        db.profiles.push(profile);
        saveLocalDB(db);
    }
}

async function checkSupabaseBackend() {
    try {
        const { error } = await sb.from('companies').select('id').limit(1);
        return !error;
    } catch (err) {
        console.warn('Supabase backend unavailable:', err);
        return false;
    }
}

async function ensureBackendAvailable() {
    if (useLocalFallback) return false;
    const ok = await checkSupabaseBackend();
    if (!ok) {
        useLocalFallback = true;
        localSeedDatabase();
        return false;
    }
    return true;
}

// ============================================================================
// NAVIGATION & VIEW MANAGEMENT
// ============================================================================

function showView(viewId) {
    document.getElementById('landing-page').classList.add('d-none');
    document.getElementById('auth-page').classList.add('d-none');
    document.getElementById('dashboard-page').classList.add('d-none');

    document.getElementById(viewId).classList.remove('d-none');
}

async function showDashboard() {
    showView('dashboard-page');

    document.getElementById('user-name-display').textContent = currentUser.name;
    document.getElementById('user-role-display').textContent = currentUser.role;

    document.getElementById('employee-view').classList.add('d-none');
    document.getElementById('manager-view').classList.add('d-none');
    document.getElementById('hr-view').classList.add('d-none');

    if (currentUser.role === 'Employee') {
        document.getElementById('employee-view').classList.remove('d-none');
        await loadEmployeeDashboard();
    } else if (currentUser.role === 'Manager') {
        document.getElementById('manager-view').classList.remove('d-none');
        await loadManagerDashboard();
    } else if (currentUser.role === 'HR Admin') {
        document.getElementById('hr-view').classList.remove('d-none');
        await loadHRDashboard();
    }
}

// ============================================================================
// SESSION BOOTSTRAP
// ============================================================================

async function fetchProfile(userId) {
    if (useLocalFallback) {
        return localFetchProfile(userId);
    }

    const { data, error } = await sb
        .from('profiles')
        .select('*, companies(code, name)')
        .eq('id', userId)
        .single();

    if (error || !data) return null;

    return {
        id: data.id,
        name: data.name,
        email: data.email,
        role: data.role,
        companyId: data.company_id,
        companyCode: data.companies?.code,
        companyName: data.companies?.name,
        casualBalance: data.casual_balance,
        sickBalance: data.sick_balance,
        earnedBalance: data.earned_balance
    };
}

async function initSession() {
    const backendOk = await ensureBackendAvailable();
    if (!backendOk) {
        const localSession = loadLocalSession();
        if (localSession?.userId) {
            const profile = localFetchProfile(localSession.userId);
            if (profile) {
                currentUser = profile;
                await showDashboard();
                return;
            }
        }
        return;
    }

    const { data: { session } } = await sb.auth.getSession();
    if (session?.user) {
        const profile = await fetchProfile(session.user.id);
        if (profile) {
            currentUser = profile;
            await showDashboard();
        }
    }
}

// ============================================================================
// AUTHENTICATION
// ============================================================================

async function handleSignIn(e) {
    e.preventDefault();

    const email = document.getElementById('signin-email').value;
    const password = document.getElementById('signin-password').value;
    const errorDiv = document.getElementById('signin-error');
    const submitBtn = e.target.querySelector('button[type="submit"]');

    errorDiv.textContent = '';
    submitBtn.disabled = true;

    try {
        const backendOk = await ensureBackendAvailable();
        if (!backendOk) {
            const profile = localAuthenticate(email, password);
            if (!profile) {
                errorDiv.textContent = 'Invalid email or password';
                return;
            }

            currentUser = localFetchProfile(profile.id);
            saveLocalSession({ userId: profile.id });
            await showDashboard();
            return;
        }

        const { data, error } = await sb.auth.signInWithPassword({ email, password });

        if (error) {
            errorDiv.textContent = error.message === 'Invalid login credentials'
                ? 'Invalid email or password'
                : error.message;
            return;
        }

        const profile = await fetchProfile(data.user.id);
        if (!profile) {
            errorDiv.textContent = 'Account exists but profile setup is incomplete. Contact your admin.';
            return;
        }

        currentUser = profile;
        await showDashboard();
    } catch (err) {
        errorDiv.textContent = 'Something went wrong. Please try again.';
        console.error(err);
    } finally {
        submitBtn.disabled = false;
    }
}

function normalizeCompanyCode(code) {
    if (!code) return '';

    const characters = code.trim().toUpperCase();
    const cleaned = characters.replace(/[^A-Z0-9]/g, '');

    if (/^COMP\d{4}$/.test(cleaned)) {
        return `${cleaned.slice(0, 4)}-${cleaned.slice(4)}`;
    }

    const withHyphen = characters.replace(/[^A-Z0-9-]/g, '');
    if (/^COMP-\d{4}$/.test(withHyphen)) {
        return withHyphen;
    }

    return '';
}

async function handleSignUp(e) {
    e.preventDefault();

    const name = document.getElementById('signup-name').value;
    const email = document.getElementById('signup-email').value;
    const password = document.getElementById('signup-password').value;
    const role = document.getElementById('signup-role').value;
    const errorDiv = document.getElementById('signup-error');
    const submitBtn = e.target.querySelector('button[type="submit"]');

    errorDiv.textContent = '';
    submitBtn.disabled = true;

    try {
        let companyName, companyCodeInput, company;

        if (role === 'HR Admin') {
            companyName = document.getElementById('signup-company-name').value.trim();
            if (!companyName) {
                errorDiv.textContent = 'Company name is required';
                return;
            }
        } else {
            companyCodeInput = normalizeCompanyCode(document.getElementById('signup-company-code').value);
            if (!companyCodeInput) {
                errorDiv.textContent = 'Company code is required and must match COMP-1234 format.';
                return;
            }
        }

        const backendOk = await ensureBackendAvailable();
        if (!backendOk) {
            if (localFindProfileByEmail(email)) {
                errorDiv.textContent = 'Email already registered';
                return;
            }

            if (role === 'HR Admin') {
                company = localCreateCompany(companyName);
            } else {
                company = localFindCompanyByCode(companyCodeInput);
                if (!company) {
                    errorDiv.textContent = 'Invalid Company Code';
                    return;
                }
            }

            const profileData = {
                id: localGenerateId('profile'),
                name,
                email,
                password,
                role,
                company_id: company.id,
                casual_balance: 12,
                sick_balance: 10,
                earned_balance: 15,
                created_at: new Date().toISOString()
            };
            localCreateProfile(profileData);
            saveLocalSession({ userId: profileData.id });

            currentUser = localFetchProfile(profileData.id);
            await showDashboard();
            return;
        }

        if (role !== 'HR Admin') {
            const { data: existingCompany, error: lookupError } = await sb
                .from('companies')
                .select('id, code, name')
                .eq('code', companyCodeInput)
                .maybeSingle();

            if (lookupError) {
                errorDiv.textContent = 'Could not validate Company Code. Please try again.';
                console.error(lookupError);
                return;
            }

            if (!existingCompany) {
                errorDiv.textContent = 'Invalid Company Code';
                return;
            }
        }

        // 1) Create the auth user
        const { data: signUpData, error: signUpError } = await sb.auth.signUp({ email, password });

        if (signUpError) {
            errorDiv.textContent = signUpError.message.includes('already registered')
                ? 'Email already registered'
                : signUpError.message;
            return;
        }

        const userId = signUpData.user?.id;
        if (!userId) {
            errorDiv.textContent = 'Sign up did not return a user. Check your email confirmation settings.';
            return;
        }

        // 2) Resolve / create the company
        let companyId, companyCode, resolvedCompanyName;

        if (role === 'HR Admin') {
            const { data: newCompany, error: companyError } = await sb
                .from('companies')
                .insert({ name: companyName })
                .select()
                .single();

            if (companyError) {
                errorDiv.textContent = 'Could not create company: ' + companyError.message;
                return;
            }
            companyId = newCompany.id;
            companyCode = newCompany.code;
            resolvedCompanyName = newCompany.name;
        } else {
            const { data: existingCompany } = await sb
                .from('companies')
                .select('id, code, name')
                .eq('code', companyCodeInput)
                .single();
            companyId = existingCompany.id;
            companyCode = existingCompany.code;
            resolvedCompanyName = existingCompany.name;
        }

        // 3) Create the profile row
        const { error: profileError } = await sb.from('profiles').insert({
            id: userId,
            name,
            email,
            role,
            company_id: companyId
        });

        if (profileError) {
            errorDiv.textContent = 'Could not create profile: ' + profileError.message;
            return;
        }

        // If email confirmation is enabled in your Supabase Auth settings,
        // there will be no session yet — tell the user to confirm their email.
        if (!signUpData.session) {
            errorDiv.textContent = '';
            alert('Account created! Please check your email to confirm your address, then sign in.');
            document.getElementById('signin-tab').click();
            return;
        }

        currentUser = {
            id: userId, name, email, role,
            companyId, companyCode, companyName: resolvedCompanyName,
            casualBalance: 12, sickBalance: 10, earnedBalance: 15
        };

        await showDashboard();
    } catch (err) {
        errorDiv.textContent = 'Something went wrong. Please try again.';
        console.error(err);
    } finally {
        submitBtn.disabled = false;
    }
}

async function handleLogout() {
    if (useLocalFallback) {
        clearLocalSession();
        currentUser = null;
        showView('landing-page');
        return;
    }

    await sb.auth.signOut();
    currentUser = null;
    showView('landing-page');
}

// ============================================================================
// DYNAMIC FORM FIELDS (Role-based)
// ============================================================================

function handleRoleChange() {
    const role = document.getElementById('signup-role').value;
    const companyNameGroup = document.getElementById('company-name-group');
    const companyCodeGroup = document.getElementById('company-code-group');

    companyNameGroup.classList.add('d-none');
    companyCodeGroup.classList.add('d-none');
    document.getElementById('signup-company-name').required = false;
    document.getElementById('signup-company-code').required = false;

    if (role === 'HR Admin') {
        companyNameGroup.classList.remove('d-none');
        document.getElementById('signup-company-name').required = true;
    } else if (role === 'Employee' || role === 'Manager') {
        companyCodeGroup.classList.remove('d-none');
        document.getElementById('signup-company-code').required = true;
    }
}

// ============================================================================
// EMPLOYEE DASHBOARD
// ============================================================================

async function loadEmployeeDashboard() {
    document.getElementById('casual-balance').textContent = currentUser.casualBalance;
    document.getElementById('sick-balance').textContent = currentUser.sickBalance;
    document.getElementById('earned-balance').textContent = currentUser.earnedBalance;

    await loadEmployeeRequests();
}

async function loadEmployeeRequests() {
    const { data: requests, error } = await sb
        .from('leave_requests')
        .select('*')
        .eq('user_id', currentUser.id)
        .order('created_at', { ascending: false });

    const tbody = document.getElementById('employee-requests-tbody');
    tbody.innerHTML = '';

    if (error) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-center">Could not load requests</td></tr>';
        console.error(error);
        return;
    }

    if (!requests || requests.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-center">No leave requests yet</td></tr>';
        return;
    }

    requests.forEach(request => {
        tbody.appendChild(createEmployeeRequestRow(mapRequest(request)));
    });
}

function createEmployeeRequestRow(request) {
    const tr = document.createElement('tr');
    const days = calculateDays(request.startDate, request.endDate);
    const statusClass = `status-${request.status.toLowerCase()}`;
    const leaveClass = `leave-${request.leaveType.toLowerCase()}`;

    tr.innerHTML = `
        <td><span class="leave-badge ${leaveClass}">${request.leaveType}</span></td>
        <td>${formatDate(request.startDate)}</td>
        <td>${formatDate(request.endDate)}</td>
        <td>${days}</td>
        <td>${truncateText(request.reason, 40)}</td>
        <td><span class="status-badge ${statusClass}">${request.status}</span></td>
        <td>${formatDate(request.createdAt)}</td>
    `;

    return tr;
}

async function handleLeaveRequest(e) {
    e.preventDefault();

    const leaveType = document.getElementById('leave-type').value;
    const startDate = document.getElementById('start-date').value;
    const endDate = document.getElementById('end-date').value;
    const reason = document.getElementById('reason').value;

    const errorDiv = document.getElementById('request-error');
    const successDiv = document.getElementById('request-success');
    const submitBtn = e.target.querySelector('button[type="submit"]');

    errorDiv.textContent = '';
    successDiv.textContent = '';

    const now = new Date();
    const requestStart = new Date(startDate);
    const hoursDiff = (requestStart - now) / (1000 * 60 * 60);

    if (hoursDiff < 24) {
        errorDiv.textContent = 'Leave requests must be submitted at least 24 hours in advance.';
        return;
    }

    if (new Date(endDate) < new Date(startDate)) {
        errorDiv.textContent = 'End date cannot be before start date.';
        return;
    }

    const daysRequested = calculateDays(startDate, endDate);

    const balanceField = leaveType === 'Casual' ? 'casualBalance' :
                         leaveType === 'Sick' ? 'sickBalance' : 'earnedBalance';
    const currentBalance = currentUser[balanceField];

    if (daysRequested > currentBalance) {
        errorDiv.textContent = `Insufficient ${leaveType} leave balance. Available: ${currentBalance} days, Requested: ${daysRequested} days.`;
        return;
    }

    submitBtn.disabled = true;
    try {
        const { error } = await sb.from('leave_requests').insert({
            user_id: currentUser.id,
            user_name: currentUser.name,
            company_id: currentUser.companyId,
            leave_type: leaveType,
            start_date: startDate,
            end_date: endDate,
            reason
        });

        if (error) {
            errorDiv.textContent = 'Could not submit request: ' + error.message;
            return;
        }

        successDiv.textContent = 'Leave request submitted successfully!';
        e.target.reset();
        await loadEmployeeRequests();
    } finally {
        submitBtn.disabled = false;
    }
}

// ============================================================================
// MANAGER DASHBOARD (RLS already scopes results to the manager's company)
// ============================================================================

async function loadManagerDashboard() {
    await loadManagerPendingRequests();
    await loadManagerAllRequests();
}

async function loadManagerPendingRequests() {
    const { data: requests, error } = await sb
        .from('leave_requests')
        .select('*')
        .eq('company_id', currentUser.companyId)
        .eq('status', 'Pending')
        .order('created_at', { ascending: true });

    const tbody = document.getElementById('manager-pending-tbody');
    tbody.innerHTML = '';

    if (error) {
        tbody.innerHTML = '<tr><td colspan="8" class="text-center">Could not load requests</td></tr>';
        console.error(error);
        return;
    }

    if (!requests || requests.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="text-center">No pending requests</td></tr>';
        return;
    }

    requests.forEach(request => {
        tbody.appendChild(createManagerPendingRow(mapRequest(request)));
    });
}

function createManagerPendingRow(request) {
    const tr = document.createElement('tr');
    const days = calculateDays(request.startDate, request.endDate);
    const leaveClass = `leave-${request.leaveType.toLowerCase()}`;

    tr.innerHTML = `
        <td>${request.userName}</td>
        <td><span class="leave-badge ${leaveClass}">${request.leaveType}</span></td>
        <td>${formatDate(request.startDate)}</td>
        <td>${formatDate(request.endDate)}</td>
        <td>${days}</td>
        <td>${truncateText(request.reason, 30)}</td>
        <td>${formatDate(request.createdAt)}</td>
        <td>
            <button class="btn btn-success" onclick="approveRequest('${request.id}')">Approve</button>
            <button class="btn btn-danger" onclick="openRejectModal('${request.id}')">Reject</button>
        </td>
    `;

    return tr;
}

async function loadManagerAllRequests() {
    const { data: requests, error } = await sb
        .from('leave_requests')
        .select('*')
        .eq('company_id', currentUser.companyId)
        .order('created_at', { ascending: false });

    const tbody = document.getElementById('manager-all-tbody');
    tbody.innerHTML = '';

    if (error) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-center">Could not load requests</td></tr>';
        console.error(error);
        return;
    }

    if (!requests || requests.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-center">No requests found</td></tr>';
        return;
    }

    requests.forEach(request => {
        tbody.appendChild(createManagerAllRow(mapRequest(request)));
    });
}

function createManagerAllRow(request) {
    const tr = document.createElement('tr');
    const days = calculateDays(request.startDate, request.endDate);
    const statusClass = `status-${request.status.toLowerCase()}`;
    const leaveClass = `leave-${request.leaveType.toLowerCase()}`;

    tr.innerHTML = `
        <td>${request.userName}</td>
        <td><span class="leave-badge ${leaveClass}">${request.leaveType}</span></td>
        <td>${formatDate(request.startDate)}</td>
        <td>${formatDate(request.endDate)}</td>
        <td>${days}</td>
        <td><span class="status-badge ${statusClass}">${request.status}</span></td>
        <td>${formatDate(request.createdAt)}</td>
    `;

    return tr;
}

async function approveRequest(requestId) {
    // Does the status update + balance deduction atomically on the server
    const { error } = await sb.rpc('approve_leave_request', { p_request_id: requestId });

    if (error) {
        alert('Could not approve request: ' + error.message);
        return;
    }

    await loadManagerDashboard();
    alert('Leave request approved successfully!');
}

function openRejectModal(requestId) {
    const modal = document.getElementById('rejection-modal');
    modal.classList.remove('d-none');
    modal.dataset.requestId = requestId;

    document.getElementById('rejection-reason').value = '';
    document.getElementById('modal-error').textContent = '';
}

function closeRejectModal() {
    const modal = document.getElementById('rejection-modal');
    modal.classList.add('d-none');
    delete modal.dataset.requestId;
}

async function submitRejection() {
    const modal = document.getElementById('rejection-modal');
    const requestId = modal.dataset.requestId;
    const reason = document.getElementById('rejection-reason').value.trim();
    const errorDiv = document.getElementById('modal-error');

    errorDiv.textContent = '';

    if (!reason) {
        errorDiv.textContent = 'Rejection reason is required.';
        return;
    }

    const { error } = await sb
        .from('leave_requests')
        .update({ status: 'Rejected', rejection_reason: reason })
        .eq('id', requestId);

    if (error) {
        errorDiv.textContent = 'Could not reject request: ' + error.message;
        return;
    }

    closeRejectModal();
    await loadManagerDashboard();
    alert('Leave request rejected.');
}

// ============================================================================
// HR ADMIN DASHBOARD (RLS already scopes results to the admin's company)
// ============================================================================

async function loadHRDashboard() {
    document.getElementById('company-name-display').textContent = currentUser.companyName;
    document.getElementById('company-code-display').textContent = currentUser.companyCode;

    await loadHRMetrics();
    await loadHREmployees();
    await loadHRAllRequests();
}

async function loadHRMetrics() {
    const [{ data: companyUsers }, { data: companyRequests }] = await Promise.all([
        sb.from('profiles').select('*').eq('company_id', currentUser.companyId),
        sb.from('leave_requests').select('*').eq('company_id', currentUser.companyId)
    ]);

    const users = companyUsers || [];
    const requests = (companyRequests || []).map(mapRequest);

    document.getElementById('total-employees-metric').textContent = users.length;

    const pendingCount = requests.filter(r => r.status === 'Pending').length;
    document.getElementById('pending-requests-metric').textContent = pendingCount;

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const approvedThisMonth = requests.filter(r =>
        r.status === 'Approved' && new Date(r.createdAt) >= startOfMonth
    ).length;
    document.getElementById('approved-month-metric').textContent = approvedThisMonth;

    let totalDays = 0;
    requests.filter(r => r.status === 'Approved').forEach(r => {
        totalDays += calculateDays(r.startDate, r.endDate);
    });
    document.getElementById('total-days-metric').textContent = totalDays;
}

async function loadHREmployees() {
    const { data: users, error } = await sb
        .from('profiles')
        .select('*')
        .eq('company_id', currentUser.companyId)
        .order('name');

    const tbody = document.getElementById('hr-employees-tbody');
    tbody.innerHTML = '';

    if (error) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center">Could not load employees</td></tr>';
        console.error(error);
        return;
    }

    if (!users || users.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center">No employees found</td></tr>';
        return;
    }

    users.forEach(user => {
        tbody.appendChild(createHREmployeeRow(user));
    });
}

function createHREmployeeRow(user) {
    const tr = document.createElement('tr');

    tr.innerHTML = `
        <td>${user.name}</td>
        <td>${user.email}</td>
        <td><span class="user-badge">${user.role}</span></td>
        <td>${user.casual_balance}</td>
        <td>${user.sick_balance}</td>
        <td>${user.earned_balance}</td>
    `;

    return tr;
}

async function loadHRAllRequests() {
    const { data: requests, error } = await sb
        .from('leave_requests')
        .select('*')
        .eq('company_id', currentUser.companyId)
        .order('created_at', { ascending: false });

    const tbody = document.getElementById('hr-all-requests-tbody');
    tbody.innerHTML = '';

    if (error) {
        tbody.innerHTML = '<tr><td colspan="8" class="text-center">Could not load requests</td></tr>';
        console.error(error);
        return;
    }

    if (!requests || requests.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="text-center">No requests found</td></tr>';
        return;
    }

    requests.forEach(request => {
        tbody.appendChild(createHRRequestRow(mapRequest(request)));
    });
}

function createHRRequestRow(request) {
    const tr = document.createElement('tr');
    const days = calculateDays(request.startDate, request.endDate);
    const statusClass = `status-${request.status.toLowerCase()}`;
    const leaveClass = `leave-${request.leaveType.toLowerCase()}`;

    tr.innerHTML = `
        <td>${request.userName}</td>
        <td><span class="leave-badge ${leaveClass}">${request.leaveType}</span></td>
        <td>${formatDate(request.startDate)}</td>
        <td>${formatDate(request.endDate)}</td>
        <td>${days}</td>
        <td><span class="status-badge ${statusClass}">${request.status}</span></td>
        <td>${truncateText(request.reason, 30)}</td>
        <td>${formatDate(request.createdAt)}</td>
    `;

    return tr;
}

function copyCompanyCode() {
    const code = document.getElementById('company-code-display').textContent;
    navigator.clipboard.writeText(code).then(() => {
        const btn = document.getElementById('copy-code-btn');
        const originalText = btn.textContent;
        btn.textContent = '✓ Copied!';
        setTimeout(() => {
            btn.textContent = originalText;
        }, 2000);
    }).catch(() => {
        alert(`Company Code: ${code}\n\nPlease copy manually.`);
    });
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

// Converts a raw Postgres row (snake_case) into the camelCase shape the
// render functions expect.
function mapRequest(row) {
    return {
        id: row.id,
        userId: row.user_id,
        userName: row.user_name,
        companyId: row.company_id,
        leaveType: row.leave_type,
        startDate: row.start_date,
        endDate: row.end_date,
        reason: row.reason,
        status: row.status,
        rejectionReason: row.rejection_reason,
        createdAt: row.created_at
    };
}

function calculateDays(startDate, endDate) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const diff = Math.abs(end - start);
    const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
    return days + 1;
}

function formatDate(dateString) {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
    });
}

function truncateText(text, maxLength) {
    if (!text) return '';
    return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
}

// ============================================================================
// EVENT LISTENERS
// ============================================================================

document.addEventListener('DOMContentLoaded', () => {

    initSession();

    document.getElementById('nav-login-btn').addEventListener('click', () => {
        showView('auth-page');
    });

    document.getElementById('hero-cta-btn').addEventListener('click', () => {
        showView('auth-page');
    });

    document.getElementById('back-to-landing').addEventListener('click', () => {
        showView('landing-page');
    });

    document.getElementById('signin-tab').addEventListener('click', () => {
        document.getElementById('signin-tab').classList.add('active');
        document.getElementById('signup-tab').classList.remove('active');
        document.getElementById('signin-form').classList.add('active');
        document.getElementById('signup-form').classList.remove('active');
        document.getElementById('auth-title').textContent = 'Sign In to Your Portal';
    });

    document.getElementById('signup-tab').addEventListener('click', () => {
        document.getElementById('signup-tab').classList.add('active');
        document.getElementById('signin-tab').classList.remove('active');
        document.getElementById('signup-form').classList.add('active');
        document.getElementById('signin-form').classList.remove('active');
        document.getElementById('auth-title').textContent = 'Create Your Account';
    });

    document.getElementById('signup-role').addEventListener('change', handleRoleChange);

    document.getElementById('signin-form').addEventListener('submit', handleSignIn);
    document.getElementById('signup-form').addEventListener('submit', handleSignUp);
    document.getElementById('logout-btn').addEventListener('click', handleLogout);
    document.getElementById('leave-request-form').addEventListener('submit', handleLeaveRequest);

    document.getElementById('modal-close-btn').addEventListener('click', closeRejectModal);
    document.getElementById('modal-cancel-btn').addEventListener('click', closeRejectModal);
    document.getElementById('modal-submit-btn').addEventListener('click', submitRejection);
    document.querySelector('.modal-overlay').addEventListener('click', closeRejectModal);

    document.getElementById('copy-code-btn').addEventListener('click', copyCompanyCode);

});

// Global functions for onclick handlers
window.approveRequest = approveRequest;
window.openRejectModal = openRejectModal;
window.closeRejectModal = closeRejectModal;
window.submitRejection = submitRejection;
