// ==================================================================platform.js=================================================
const loginForm = document.getElementById('loginFormElement');
const loginBtn = document.getElementById('loginBtn');
const errorMessage = document.getElementById('errorMessage');
const loginFormContainer = document.getElementById('loginForm');
const dashboardContent = document.getElementById('dashboardContent');
const logoutBtn = document.getElementById('logoutBtn');
const userEmailSpan = document.getElementById('userEmail');
const createLoginUserForm = document.getElementById('createLoginUserForm');
const createLoginUserMessage = document.getElementById('createLoginUserMessage');
const createLoginUserButton = document.getElementById('createLoginUserButton');


let currentUser = null;
// Will be set later so login/session code can trigger a refresh
let refreshCreateUserFormOptionsGlobal = null;

// Map of screenId -> { read, write, edit, delete } for the logged-in user
let screenPermissionsById = {};

// Helper to check if the current user has a given permission on a screen
// perm can be: 'read', 'write', 'edit', 'delete'
function canScreen(screenId, perm = 'read') {
  const key = String(screenId);
  const perms = screenPermissionsById[key];
  if (!perms) return false;
  return !!perms[perm];
}




// ===== Dynamic Create-User Form configuration =====

// Categories
const USER_CATEGORY = {
  PROVIDER: 'provider',
  SCRIBE: 'scribe',
  EMPLOYEE: 'employee',
  PATIENT: 'patient',
};

// These will later be filled from API (clinics, rights, managers, etc.)
const userFormDynamicOptions = {
  clinics: [], // [{ id, name }]
  providers: [],
  // List of all XR screens from System_Screens, used for the rights checkboxes
  screens: [],  // [{ id, name }]
  providerRights: [],
  scribeRights: [],
  employeeRights: [],
  managers: [], // [{ id, name }]
};



// Assign Users dropdown options (scribes + providers)
// Filled via /api/platform/assign-users/options when Assign Users view opens.
let assignUsersOptions = {
  scribes: [],   // [{ id, full_name }]
  providers: [], // [{ id, full_name }]
};



// Load dropdown options (clinics, etc.) from backend
async function loadUserFormOptions() {
  try {
    const response = await fetch('/api/platform/lookup-options', {
      method: 'GET',
      credentials: 'include',
    });

    if (!response.ok) {
      console.error(
        'Lookup options request failed with status',
        response.status
      );
      return; // stop, but don't throw
    }

    const data = await response.json();
    if (!data.ok || !data.options) return;

    const { clinics, screens, managers } = data.options;


    // Map clinics -> [{ id, name }]
    if (Array.isArray(clinics)) {
      userFormDynamicOptions.clinics = clinics.map(c => ({
        id: c.id,
        name: c.clinic_name || c.clinic || c.name,
      }));
    }

    // Map managers -> [{ id, name }]
    if (Array.isArray(managers)) {
      userFormDynamicOptions.managers = managers.map(m => ({
        id: m.id,
        name: m.full_name || m.name,
      }));
    } else {
      userFormDynamicOptions.managers = [];
    }

    // Map screens -> [{ id, name, screen_name, route_path }]
    if (Array.isArray(screens)) {
      userFormDynamicOptions.screens = screens.map(s => ({
        id: s.id,
        // Display name
        name: s.screen_name || s.name || s.route_path || `Screen ${s.id}`,
        // Extra fields so we can categorize into XR vs Menu modules
        screen_name: s.screen_name || s.name || '',
        route_path: s.route_path || '',
      }));
    }






    // (Later we can also populate providers / managers / rights here)
  } catch (err) {
    console.error('Failed to load user-form options:', err);
  }
}

// Full field definitions for each category
const baseCategoryConfig = {
  [USER_CATEGORY.PROVIDER]: {
    label: 'Provider',
    formFields: [
      { name: 'name', label: 'Name', type: 'text', required: true },
      { name: 'email', label: 'Email', type: 'email', required: true },
      { name: 'clinic', label: 'Clinic', type: 'select', required: true, optionsKey: 'clinics' },
      { name: 'status', label: 'Status', type: 'select', options: ['Active', 'Inactive'] },
      { name: 'xrId', label: 'XR ID', type: 'text', required: true },
      { name: 'rights', label: 'Screen Access', type: 'checkbox-group', optionsKey: 'screens' },
      { name: 'password', label: 'Password', type: 'password', required: true }
      // Provider never has reporting manager
    ]
  },

  [USER_CATEGORY.SCRIBE]: {
    label: 'Scribe',
    formFields: [
      { name: 'name', label: 'Name', type: 'text', required: true },
      { name: 'email', label: 'Email', type: 'email', required: true },
      { name: 'clinic', label: 'Clinic', type: 'select', required: false, optionsKey: 'clinics' },
      { name: 'primaryProviderId', label: 'Primary Provider', type: 'select', optionsKey: 'providers' },
      { name: 'status', label: 'Status', type: 'select', options: ['Active', 'Inactive'] },
      { name: 'xrId', label: 'XR ID', type: 'text', required: true },
      { name: 'rights', label: 'Screen Access', type: 'checkbox-group', optionsKey: 'screens' },

      { name: 'password', label: 'Password', type: 'password', required: true },

      // Only visible when creator is Admin / SuperAdmin (hidden for Manager)
      { name: 'reportingManagerId', label: 'Reporting Manager', type: 'select', optionsKey: 'managers', conditional: true }
    ]
  },

  [USER_CATEGORY.EMPLOYEE]: {
    label: 'Employee',
    formFields: [
      { name: 'name', label: 'Name', type: 'text', required: true },
      { name: 'email', label: 'Email', type: 'email', required: true },

      {
        name: 'department',
        label: 'Department',
        type: 'select',
        // IMPORTANT: these values must match the Departments table exactly
        options: ['IT', 'OPS', 'FIN'],
        required: true
      },


      {
        name: 'type',
        label: 'Type',
        type: 'select',
        options: ['SuperAdmin', 'Admin', 'Scribe', 'Employee', 'Manager'],
        required: true
      },

      { name: 'status', label: 'Status', type: 'select', options: ['Active', 'Inactive'] },

      {
        name: 'password',
        label: 'Password',
        type: 'password',
        required: true
      },

      { name: 'rights', label: 'Screen Access', type: 'checkbox-group', optionsKey: 'screens' },


      // Only visible when creator is Admin / SuperAdmin (hidden for Manager)
      { name: 'reportingManagerId', label: 'Reporting Manager', type: 'select', optionsKey: 'managers', conditional: true }
    ]
  }

  ,

  [USER_CATEGORY.PATIENT]: {
    label: 'Patient',
    formFields: [
      { name: 'name', label: 'Full Name', type: 'text', required: true },

      { name: 'email', label: 'Email', type: 'email', required: true },

      {
        name: 'contact_no_primary',
        label: 'Phone Number',
        type: 'text',
        required: true
      },

      {
        name: 'mrn_no',
        label: 'MRN Number',
        type: 'text',
        required: true
      },

      {
        name: 'password',
        label: 'Password',
        type: 'password',
        required: true
      }

      // 🚫 No clinic
      // 🚫 No XR ID
      // 🚫 No reporting manager
      // 🚫 No screen access
    ]
  }

};

// Helper: normalise currentUser.role
// Helper: normalise creator "role" for the Create User form
function getCreatorRole() {
  if (!currentUser) return 'admin';

  // Prefer type/userType from the session (Types table)
  const type = currentUser.type || currentUser.userType || '';

  // True Master Admin / SuperAdmin
  if (type === 'SuperAdmin') return 'super_admin';

  // Real manager
  if (type === 'Manager') return 'manager';

  // Everyone else (Admin, Scribe, Employee, Provider, etc.)
  // is treated like "admin" for the create-user form purposes
  return 'admin';
}


// Helper: unified SuperAdmin check (only Master Admin should pass)
function isCurrentUserSuperAdmin() {
  if (!currentUser) return false;

  const type = currentUser.type || currentUser.userType;
  const role = currentUser.role;
  const name = currentUser.name || currentUser.full_name;

  // Backend now sets role === 'superadmin' only for Master Admin.
  // We also fall back to type/name just in case frontend gets extra info.
  if (role === 'superadmin') return true;
  if (type === 'SuperAdmin') return true;
  if (name === 'Master Admin') return true; // full name from your table

  return false;
}

// Helper: given a category + creatorRole, decide which fields to show
function getFormConfigForCategory(category, creatorRole) {
  const base = baseCategoryConfig[category];
  if (!base) return null;

  // NEW RULE:
  // Any user who has access to the Create Users screen should see
  // the exact same fields as Master Admin. We no longer hide
  // reportingManagerId based on the creator's role/type.
  //
  // So we just return the full formFields array for that category.
  const fields = base.formFields.slice(); // shallow copy

  return { ...base, formFields: fields };
}



function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

async function checkSession() {
  try {
    const response = await fetch('/api/platform/me', {
      method: 'GET',
      credentials: 'include',
    });
    const data = await response.json();

    if (data.ok) {
      // set currentUser for ALL roles
      currentUser = data;
      await showDashboard(data.email);


      // Only SuperAdmin should load create-user lookup options
      // Only SuperAdmin should load create-user lookup options
      if (isCurrentUserSuperAdmin() && typeof refreshCreateUserFormOptionsGlobal === 'function') {
        refreshCreateUserFormOptionsGlobal();
      }



    } else {
      showLoginForm();
    }
  } catch (err) {
    console.error('Session check failed:', err);
    showLoginForm();
  }
}


function showLoginForm() {
  loginFormContainer.classList.remove('hidden');
  dashboardContent.classList.add('hidden');
}

async function showDashboard(email) {
  loginFormContainer.classList.add('hidden');
  dashboardContent.classList.remove('hidden');

  if (userEmailSpan) {
    userEmailSpan.textContent = email || 'Super Admin';
  }

  // ✅ Ensure screenPermissionsById is populated before any view uses canScreen()
  await applyScreenVisibility();

  // Now safe to render views and allow navigation
  switchView('dashboard');

  // NEW: load manager + reportees info for the logged-in user
  loadUserRelations();
}




async function applyScreenVisibility() {
  try {
    const response = await fetch('/api/platform/my-screens', {
      method: 'GET',
      credentials: 'include',
      headers: {
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      console.warn('my-screens request failed with status', response.status);
      return;
    }

    const data = await response.json();
    if (!data.ok) {
      console.warn('my-screens response not ok:', data.message);
      return;
    }

    // ⬇️ NEW: store full permissions for quick lookup
    screenPermissionsById = {};
    (data.screens || []).forEach((s) => {
      screenPermissionsById[String(s.id)] = {
        read: !!s.read,
        write: !!s.write,
        edit: !!s.edit,
        delete: !!s.delete,
      };
    });

    // For visibility, we still only care about READ = 1
    const allowedScreens = (data.screens || [])
      .filter((s) => s.read)        // safeguard, though backend already filters
      .map((s) => String(s.id));

    const allowedSet = new Set(allowedScreens);


    const items = document.querySelectorAll('.xr-screen-item');
    // Sidebar items that are tied to specific screens
    const sidebarItems = document.querySelectorAll('.sidebar-item[data-screen-id]');

    // 🔒 If backend says “no screens”, hide everything for safety.
    if (!allowedScreens.length) {
      items.forEach(item => item.classList.add('hidden'));
      sidebarItems.forEach(item => item.classList.add('hidden'));
      return;
    }

    // Otherwise: show only the screens returned by the backend
    items.forEach(item => {
      const id = item.getAttribute('data-screen-id');
      if (allowedSet.has(id)) {
        item.classList.remove('hidden');
      } else {
        item.classList.add('hidden');
      }
    });

    // Apply the same logic to sidebar entries
    sidebarItems.forEach(item => {
      const id = item.getAttribute('data-screen-id');
      if (allowedSet.has(id)) {
        item.classList.remove('hidden');
      } else {
        item.classList.add('hidden');
      }
    });


  } catch (err) {
    console.error('applyScreenVisibility error:', err);
  }
}



// Load Profile Panel Data
// ===============================================
async function loadProfileData() {
  try {
    // --- Always clear hierarchy UI first (prevents stale tree) ---
    const hierarchySection = document.getElementById('profileHierarchySection');
    const treeContainer = document.getElementById('profileHierarchyTree');
    const statsEl = document.getElementById('profileHierarchyStats');

    // Hide & clear immediately, so old SuperAdmin tree never leaks
    if (hierarchySection) hierarchySection.classList.add('hidden');
    if (treeContainer) treeContainer.innerHTML = '';
    if (statsEl) statsEl.textContent = '';



    const res = await fetch('/api/platform/my-relations', {
      method: 'GET',
      credentials: 'include'
    });

    const data = await res.json();
    if (!data.ok) return;

    // ===== Basic profile info =====
    const profileNameEl = document.getElementById("profileName");
    const profileEmailEl = document.getElementById("profileEmail");
    const profileRoleEl = document.getElementById("profileRole");

    if (profileNameEl) {
      profileNameEl.innerText =
        data.me.full_name || data.me.name || 'Unknown';
    }

    if (profileEmailEl) profileEmailEl.innerText = data.me.email;

    // Prefer role/userType from backend; fall back to currentUser.type
    const roleLabel =
      data.me.userType ||
      data.me.role ||
      (currentUser && currentUser.type) ||
      'User';

    if (profileRoleEl) profileRoleEl.innerText = roleLabel;

    // ===== Reporting To =====
    const reportingToEl = document.getElementById("profileReportingTo");
    if (reportingToEl) {
      reportingToEl.innerText = data.manager ? data.manager.name : "None";
    }

    // ===== My Reportees =====
    const repList = document.getElementById("profileReportees");
    if (repList) {
      repList.innerHTML = "";

      if (!data.reportees || data.reportees.length === 0) {
        repList.innerHTML = "<li>No reportees</li>";
      } else {
        data.reportees.forEach(r => {
          const li = document.createElement("li");
          li.innerText = r.full_name || r.name;
          repList.appendChild(li);
        });
      }
    }

    // ================= HIERARCHY TREE =================
    // SuperAdmin (Master Admin) -> full organization tree
    // Any user with reportees (Manager/Admin/etc.) -> subtree under them
    const isSuperAdmin = isCurrentUserSuperAdmin();
    const hasReportees = Array.isArray(data.reportees) && data.reportees.length > 0;

    try {
      let hRes;

      if (isSuperAdmin) {
        // Master Admin → full organization tree
        hRes = await fetch('/api/platform/user-hierarchy', {
          method: 'GET',
          credentials: 'include'
        });
      } else if (hasReportees) {
        // Any user (Manager/Admin/etc.) with reportees → subtree under them
        hRes = await fetch('/api/platform/my-hierarchy', {
          method: 'GET',
          credentials: 'include'
        });
      } else {
        // No reportees → hide hierarchy section and stop
        if (hierarchySection) hierarchySection.classList.add('hidden');
        if (treeContainer) treeContainer.innerHTML = '';
        if (statsEl) statsEl.textContent = '';
        return;
      }

      if (!hRes.ok) {
        console.warn('hierarchy request failed with status', hRes.status);
      } else {
        const hData = await hRes.json();
        if (hData && hData.ok) {
          renderProfileHierarchy(hData.roots || [], hData.stats || {});
        }
      }
    } catch (err2) {
      console.error('hierarchy load error:', err2);
    }

  } catch (err) {
    console.error("profile error:", err);
  }
}


// Render organization hierarchy (full org for SuperAdmin, subtree for others)
// Render organization hierarchy (full org for SuperAdmin, subtree for others)
function renderProfileHierarchy(roots, stats) {
  const section = document.getElementById('profileHierarchySection');
  const treeContainer = document.getElementById('profileHierarchyTree');
  const statsEl = document.getElementById('profileHierarchyStats');
  const titleEl = document.getElementById('profileHierarchyTitle');

  // If the HTML doesn't have these elements yet, just bail out quietly.
  if (!section || !treeContainer) {
    return;
  }

  if (!Array.isArray(roots) || roots.length === 0) {
    section.classList.add('hidden');
    treeContainer.innerHTML = '';
    if (statsEl) statsEl.textContent = '';
    return;
  }

  section.classList.remove('hidden');
  treeContainer.innerHTML = '';

  const ul = buildHierarchyList(roots);
  treeContainer.appendChild(ul);

  const isSuperAdmin = isCurrentUserSuperAdmin();

  // Title: "Organization Tree" for Master Admin, "My Team" for others
  if (titleEl) {
    titleEl.textContent = isSuperAdmin ? 'Organization Tree' : 'My Team';
  }

  // Stats only for Master Admin; hide for managers/others
  if (statsEl) {
    if (isSuperAdmin && stats) {
      const totalUsers = stats.totalUsers || 0;
      const totalManagers = stats.totalManagers || 0;
      const totalScribes = stats.totalScribes || 0;
      const totalProviders = stats.totalProviders || 0;

      statsEl.classList.remove('hidden');
      statsEl.textContent =
        `Total users: ${totalUsers} | ` +
        `Managers: ${totalManagers} | ` +
        `Scribes: ${totalScribes} | ` +
        `Providers: ${totalProviders}`;
    } else {
      statsEl.classList.add('hidden');
      statsEl.textContent = '';
    }
  }
}





// Modern collapsible tree for Organization hierarchy
function buildHierarchyList(nodes, level = 0) {
  const ul = document.createElement('ul');

  // Top level: no border. Nested levels: left border and extra padding.
  if (level === 0) {
    ul.className = 'list-none space-y-1';
  } else {
    ul.className =
      'list-none space-y-1 ml-3 pl-3 border-l border-slate-700/80';
  }

  nodes.forEach((node) => {
    const li = document.createElement('li');
    li.className = 'text-gray-200';

    const hasChildren = Array.isArray(node.children) && node.children.length > 0;

    // Row container: icon + main info
    const row = document.createElement('div');
    row.className =
      'flex items-start gap-2 py-1 px-2 rounded-md ' +
      (hasChildren
        ? 'hover:bg-slate-800/80 cursor-pointer'
        : 'cursor-default');

    const icon = document.createElement('span');
    icon.className = 'mt-1 text-xs text-gray-300 shrink-0';

    if (hasChildren) {
      icon.textContent = '▸'; // collapsed by default
    } else {
      icon.textContent = '•';
      icon.classList.add('opacity-60');
    }

    // User info block
    const info = document.createElement('div');
    info.className = 'flex flex-col leading-tight';

    const displayName =
      node.name || node.full_name || node.email || `User ${node.id}`;
    const role = node.role || node.role_type || 'User';
    const personaRaw = node.persona || '';
    const emailPart = node.email ? ` • ${node.email}` : '';

    const nameEl = document.createElement('span');
    nameEl.className = 'font-medium text-sm';
    nameEl.textContent = displayName;

    const metaEl = document.createElement('span');
    metaEl.className = 'text-[11px] text-gray-400';

    // If the user is a Provider, do NOT show "Employee" before it.
    // Example: "Provider • drkhan@email.com"
    let descriptor;
    if (personaRaw === 'Provider') {
      descriptor = `Provider${emailPart}`;
    } else {
      const personaPart = personaRaw ? ` • ${personaRaw}` : '';
      descriptor = `${role}${personaPart}${emailPart}`;
    }

    metaEl.textContent = descriptor;


    info.appendChild(nameEl);
    info.appendChild(metaEl);

    row.appendChild(icon);
    row.appendChild(info);
    li.appendChild(row);

    // Children (nested list)
    if (hasChildren) {
      const childUl = buildHierarchyList(node.children, level + 1);
      childUl.classList.add('hidden'); // start collapsed
      li.appendChild(childUl);

      row.addEventListener('click', () => {
        const isOpen = !childUl.classList.contains('hidden');
        if (isOpen) {
          childUl.classList.add('hidden');
          icon.textContent = '▸';
        } else {
          childUl.classList.remove('hidden');
          icon.textContent = '▾';
        }
      });
    }

    ul.appendChild(li);
  });

  return ul;
}

// Load current user's manager + reportees and update the dashboard UI
async function loadUserRelations() {
  try {
    const response = await fetch('/api/platform/my-relations', {
      method: 'GET',
      credentials: 'include',
    });

    if (!response.ok) {
      console.warn('my-relations request failed with status', response.status);
      return;
    }

    const data = await response.json();
    if (!data.ok) {
      console.warn('my-relations response not ok:', data.message);
      return;
    }

    // 1) Show "Reporting To: <Manager Name>" (or "None")
    const reportingEl = document.getElementById('reportingTo');
    if (reportingEl) {
      if (data.manager) {
        reportingEl.textContent = `Reporting To: ${data.manager.name}`;
      } else {
        reportingEl.textContent = 'Reporting To: None';
      }
    }

    // 2) Show "My Reportees" list (for managers, or empty for others)
    const reporteesListEl = document.getElementById('myReportees');
    if (reporteesListEl) {
      reporteesListEl.innerHTML = '';

      if (Array.isArray(data.reportees) && data.reportees.length > 0) {
        data.reportees.forEach(r => {
          const li = document.createElement('li');
          li.textContent = r.full_name || r.name || r.email || `User ${r.id}`;
          reporteesListEl.appendChild(li);
        });
      } else {
        // Optional: show placeholder if no reportees
        const li = document.createElement('li');
        li.textContent = 'No reportees';
        reporteesListEl.appendChild(li);
      }
    }
  } catch (err) {
    console.error('loadUserRelations error:', err);
  }
}

// Format dropdown labels as: Name (XR-ID) – Email
function formatUserDropdownLabel(user) {
  if (!user) return '';

  const name = (user.name || user.full_name || '').trim();
  const xrId = user.xr_id || user.xrId;
  const email = user.email;

  const parts = [];
  if (name) parts.push(name);
  if (xrId) parts.push(`(${xrId})`);
  if (email) parts.push(`– ${email}`);

  return parts.join(' ');
}


// ===== Assign Users: load Scribe / Provider dropdown options =====
async function loadAssignUsersOptions() {
  try {
    const res = await fetch('/api/platform/assign-users/options', {
      method: 'GET',
      credentials: 'include',
    });

    if (!res.ok) {
      console.warn('assign-users/options request failed with status', res.status);
      assignUsersOptions = { scribes: [], providers: [] };
      return;
    }

    const data = await res.json();
    if (!data.ok) {
      console.warn('assign-users/options response not ok:', data.message);
      assignUsersOptions = { scribes: [], providers: [] };
      return;
    }

    // Base lists from /assign-users/options (already scoped correctly
    // for Manager vs SuperAdmin)
    const rawScribes = Array.isArray(data.scribes) ? data.scribes : [];
    const rawProviders = Array.isArray(data.providers) ? data.providers : [];

    // NEW: try to enrich those entries with email + xr_id from /api/platform/users
    let fullUsers = [];
    try {
      const usersRes = await fetch('/api/platform/users', {
        method: 'GET',
        credentials: 'include',
      });

      if (usersRes.ok) {
        const usersData = await usersRes.json();
        if (usersData.ok && Array.isArray(usersData.users)) {
          fullUsers = usersData.users;
        }
      }
    } catch (err2) {
      console.warn('assign-users: failed to enrich options from /users:', err2);
      // fail-open: we'll just use the raw lists without email/xr_id
    }

    function enrich(list, expectedType) {
      if (!fullUsers.length) return list;
      return list.map((item) => {
        const match = fullUsers.find(
          (u) => u.id === item.id && (!expectedType || u.userType === expectedType)
        );
        // Merge so we keep manager-scoping from /options but add email/xr_id
        return match ? { ...item, ...match } : item;
      });
    }

    assignUsersOptions.scribes = enrich(rawScribes, 'Scribe');
    assignUsersOptions.providers = enrich(rawProviders, 'Provider');

  } catch (err) {
    console.error('loadAssignUsersOptions error:', err);
    // Fail-open: keep empty arrays so table falls back to old text inputs
    assignUsersOptions = { scribes: [], providers: [] };
  }
}

// ===== Assign Users: init top Scribe / Clinic / Provider filters =====
function initAssignUsersTopPanel() {
  const scribeSelect = document.getElementById('assignScribeFilter');
  const clinicSelect = document.getElementById('assignClinicFilter');
  const providerSelect = document.getElementById('assignProviderFilter');

  // If the HTML panel is not present, do nothing (fail-open)
  if (!scribeSelect || !clinicSelect || !providerSelect) {
    return;
  }

  //
  // 1) Scribe dropdown
  //    For Manager → backend already returns ONLY reportee scribes
  //    in assignUsersOptions.scribes. For SuperAdmin → all scribes.
  //
  scribeSelect.innerHTML = '<option value=\"\">Select Scribe</option>';

  (assignUsersOptions.scribes || []).forEach((s) => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = formatUserDropdownLabel(s);
    scribeSelect.appendChild(opt);
  });

  // Refresh bottom table whenever Scribe changes (to show empty-state for unmapped scribes)
  scribeSelect.onchange = async () => {
    await loadAssignUsersTable();
  };


  //
  // 2) Clinic dropdown (comes from lookup-options → userFormDynamicOptions.clinics)
  //
  clinicSelect.innerHTML = '<option value=\"\">Select Clinic</option>';

  (userFormDynamicOptions.clinics || []).forEach((c) => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name || `Clinic ${c.id}`;
    clinicSelect.appendChild(opt);
  });

  //
  // 3) Provider dropdown (filtered by selected clinic)
  //
  function refreshProviderDropdown() {
    const clinicId = clinicSelect.value;
    const providersAll = assignUsersOptions.providers || [];

    providerSelect.innerHTML = '';

    // If no clinic yet → show “Select clinic first” and disable
    if (!clinicId) {
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Select clinic first';
      providerSelect.appendChild(placeholder);
      providerSelect.disabled = true;
      return;
    }

    // Determine if backend actually sends clinic info at all
    const providerHasClinicInfo = providersAll.some((p) => {
      const provClinicId = p.clinic_id ?? p.clinicId;
      return provClinicId != null;
    });

    // Filter providers by clinic_id / clinicId (string compare for safety)
    let providers = providersAll.filter((p) => {
      const provClinicId = p.clinic_id ?? p.clinicId;
      if (provClinicId == null) return false;
      return String(provClinicId) === String(clinicId);
    });

    // Fallback ONLY if backend didn't send any clinic_id for providers
    if (!providers.length && !providerHasClinicInfo && providersAll.length) {
      // No clinic info at all → can't filter → show all providers
      providers = providersAll;
    }

    // If nothing found, keep the UI friendly
    if (!providers.length) {
      const noOpt = document.createElement('option');
      noOpt.value = '';
      noOpt.textContent = 'No providers for this clinic';
      providerSelect.appendChild(noOpt);
      providerSelect.disabled = true;
      return;
    }


    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = 'Select Provider';
    providerSelect.appendChild(defaultOpt);

    providers.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = formatUserDropdownLabel(p);
      providerSelect.appendChild(opt);
    });


    providerSelect.disabled = false;
  }

  // Initial state: disabled until a clinic is chosen
  providerSelect.innerHTML = '';
  const initialOpt = document.createElement('option');
  initialOpt.value = '';
  initialOpt.textContent = 'Select clinic first';
  providerSelect.appendChild(initialOpt);
  providerSelect.disabled = true;

  // Avoid stacking listeners: assign via .onchange
  clinicSelect.onchange = refreshProviderDropdown;

  // If a clinic is already selected for some reason, refresh immediately
  if (clinicSelect.value) {
    refreshProviderDropdown();
  }

  // 4) Top-level "Save Assignment" button → create/update mapping
  const saveAssignmentBtn = document.getElementById('assignUsersSaveButton');

  // Screen id for "Assign Users" (System_Screens.id = 8)
  const ASSIGN_USERS_SCREEN_ID = 8;

  if (saveAssignmentBtn) {
    saveAssignmentBtn.onclick = async () => {
      // Safety check (mirrors Create User screen behaviour)
      if (!canScreen(ASSIGN_USERS_SCREEN_ID, 'write')) {
        showToast(
          'You only have READ permission for Assign Users. Editing is not allowed.',
          'error'
        );
        return;
      }

      const scribeId = scribeSelect.value;
      const providerId = providerSelect.value;

      if (!scribeId || !providerId) {
        showToast('Please select both a Scribe and a Provider', 'error');
        return;
      }


      try {
        saveAssignmentBtn.disabled = true;
        saveAssignmentBtn.textContent = 'Saving...';

        const res = await fetch('/api/platform/scribe-provider-mapping', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            scribeUserId: Number(scribeId),
            providerUserId: Number(providerId),
          }),
        });

        const data = await res.json();
        if (!res.ok || !data.ok) {
          throw new Error(data.message || 'Failed to save assignment');
        }

        showToast(data.message || 'Mapping saved successfully', 'success');

        // Reload bottom table so the new/updated mapping shows up
        await loadAssignUsersTable();
      } catch (err) {
        console.error('Top-panel Save Assignment error:', err);
        showToast(err.message || 'Failed to save assignment', 'error');
      } finally {
        saveAssignmentBtn.disabled = false;
        saveAssignmentBtn.textContent = 'Save Assignment';
      }
    };
  }
}


// ================= Assign Users: Dual View (By Scribe / By Provider) =================
function initAssignUsersDualView() {
  const byScribeBtn = document.getElementById('assignViewByScribeBtn');
  const byProviderBtn = document.getElementById('assignViewByProviderBtn');

  const byScribeView = document.getElementById('assignByScribeView');
  const byProviderView = document.getElementById('assignByProviderView');

  const providerSelect = document.getElementById('assignProviderFilterByProvider');
  const clinicSelect = document.getElementById('assignClinicFilterByProvider');
  const managerSelect = document.getElementById('assignManagerFilterByProvider');
  const reporteeSelect = document.getElementById('assignReporteeFilterByProvider');

  const providerTableBody = document.getElementById('assignUsersTableByProvider');
  // ✅ Provider view: prevent column reflow when Edit mode injects controls
  const providerTableEl = providerTableBody ? providerTableBody.closest('table') : null;
  if (providerTableEl) {
    providerTableEl.classList.add('table-fixed');
    providerTableEl.style.tableLayout = 'fixed';
    providerTableEl.style.width = '100%';
  }


  // Optional button (OK if missing in HTML)
  const saveBtn = document.getElementById('assignUsersSaveButtonByProvider');



  if (!byScribeBtn || !byProviderBtn || !byScribeView || !byProviderView) return;

  const ASSIGN_USERS_SCREEN_ID = 8;

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function setActive(btnOn, btnOff) {
    btnOn.classList.add('bg-gray-700', 'text-white', 'border-gray-600');
    btnOn.classList.remove('bg-gray-800', 'text-gray-300', 'border-gray-700');

    btnOff.classList.add('bg-gray-800', 'text-gray-300', 'border-gray-700');
    btnOff.classList.remove('bg-gray-700', 'text-white', 'border-gray-600');
  }

  function showScribeView() {
    byScribeView.classList.remove('hidden');
    byProviderView.classList.add('hidden');
    setActive(byScribeBtn, byProviderBtn);
  }

  function setProviderTableMessage(msg) {
    if (!providerTableBody) return;
    providerTableBody.innerHTML = `
      <tr>
        <td colspan="9" class="py-8 text-center text-gray-500">
          ${escapeHtml(msg)}
        </td>
      </tr>
    `;
  }

  function populateClinicDropdownByProvider() {
    if (!clinicSelect) return;

    clinicSelect.innerHTML = '<option value="">Select Clinic</option>';
    (userFormDynamicOptions.clinics || []).forEach((c) => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name || c.clinic || `Clinic ${c.id}`;
      clinicSelect.appendChild(opt);
    });
  }

  function refreshProviderDropdownByClinic() {
    if (!providerSelect) return;

    const clinicId = clinicSelect ? clinicSelect.value : '';
    const providersAll = Array.isArray(assignUsersOptions.providers) ? assignUsersOptions.providers : [];

    providerSelect.innerHTML = '';

    // If no clinic yet → show “Select clinic first” and disable
    if (!clinicId) {
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Select clinic first';
      providerSelect.appendChild(placeholder);
      providerSelect.disabled = true;
      return;
    }

    // Determine if backend actually sends clinic info at all
    const providerHasClinicInfo = providersAll.some((p) => {
      const provClinicId = p.clinic_id ?? p.clinicId;
      return provClinicId != null;
    });

    // Filter providers by clinic_id / clinicId
    let providers = providersAll.filter((p) => {
      const provClinicId = p.clinic_id ?? p.clinicId;
      if (provClinicId == null) return false;
      return String(provClinicId) === String(clinicId);
    });

    // Fallback ONLY if backend didn't send any clinic_id for providers
    if (!providers.length && !providerHasClinicInfo && providersAll.length) {
      providers = providersAll;
    }

    if (!providers.length) {
      const noOpt = document.createElement('option');
      noOpt.value = '';
      noOpt.textContent = 'No providers for this clinic';
      providerSelect.appendChild(noOpt);
      providerSelect.disabled = true;
      return;
    }

    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = 'Select Provider';
    providerSelect.appendChild(defaultOpt);

    providers.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = formatUserDropdownLabel(p);
      providerSelect.appendChild(opt);
    });

    providerSelect.disabled = false;
  }
  function setProviderTopPanelInitialState() {
    // Provider dropdown starts disabled until clinic is selected
    if (providerSelect) {
      providerSelect.innerHTML = '<option value="">Select clinic first</option>';
      providerSelect.disabled = true;
    }

    // Reset downstream selects
    resetManagerAndReportee();
  }


  /* ============================
   Manager → Reportee dropdown
   ============================ */

  function populateManagerDropdown() {
    if (!managerSelect) return;

    managerSelect.innerHTML = '<option value="">Select Manager</option>';

    const allScribes = Array.isArray(assignUsersOptions.scribes)
      ? assignUsersOptions.scribes
      : [];

    const managers = Array.from(
      new Set(
        allScribes
          .map(s => String(s.managerName || s.manager_name || '').trim())
          .filter(Boolean)
      )
    );

    managers.forEach((m) => {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      managerSelect.appendChild(opt);
    });

    managerSelect.disabled = false;
  }

  function refreshReporteesByManager() {
    if (!reporteeSelect) return;

    const managerName = String(managerSelect?.value || '').trim();
    const allScribes = Array.isArray(assignUsersOptions.scribes)
      ? assignUsersOptions.scribes
      : [];

    reporteeSelect.innerHTML = '';

    if (!managerName) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'Select manager first';
      reporteeSelect.appendChild(opt);
      reporteeSelect.disabled = true;
      return;
    }

    let reportees = allScribes.filter((s) => {
      const mn = String(s.managerName || s.manager_name || '').trim();
      return mn === managerName;
    });

    // fallback safety
    if (!reportees.length) reportees = allScribes;

    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = 'Select Reportee';
    reporteeSelect.appendChild(defaultOpt);

    reportees.forEach((s) => {
      const opt = document.createElement('option');
      opt.value = s.id ?? s.user_id;
      opt.textContent = formatUserDropdownLabel(s);
      reporteeSelect.appendChild(opt);
    });

    reporteeSelect.disabled = false;
  }

  function resetManagerAndReportee() {
    if (managerSelect) {
      managerSelect.innerHTML = '<option value="">Select provider first</option>';
      managerSelect.disabled = true;
    }
    if (reporteeSelect) {
      reporteeSelect.innerHTML = '<option value="">Select manager first</option>';
      reporteeSelect.disabled = true;
    }
  }

  // Bind clinic change once (avoid stacking handlers if view re-opens)
  if (clinicSelect && !clinicSelect.dataset.byProviderClinicBound) {
    clinicSelect.dataset.byProviderClinicBound = '1';

    clinicSelect.onchange = () => {
      refreshProviderDropdownByClinic();

      // reset provider filter (prevents stale provider)
      if (providerSelect) providerSelect.value = '';

      // Immediately refresh providers tables (mapped + unmapped),
      // filtered by clinic (and provider if selected later).
      loadAssignProvidersTable();
    };

  }

  // Bind provider change once (avoid stacking / overwriting)
  if (providerSelect && !providerSelect.dataset.byProviderProviderBound) {
    providerSelect.dataset.byProviderProviderBound = '1';

    providerSelect.onchange = () => {
      // Provider is FILTER ONLY now.
      // Do not gate table rendering behind provider selection.
      loadAssignProvidersTable();
    };

  }





  async function showProviderView() {
    if (!canScreen(ASSIGN_USERS_SCREEN_ID, 'read')) {
      showToast('You do not have permission to view Assign Users.', 'error');
      return;
    }

    byScribeView.classList.add('hidden');
    byProviderView.classList.remove('hidden');
    setActive(byProviderBtn, byScribeBtn);

    // If options are not ready yet, don’t crash — show message
    // If options are not ready yet, don’t crash — show message
    if (!Array.isArray(assignUsersOptions.providers)) {
      // show placeholder safely (no undefined function call)
      if (providerSelect) {
        providerSelect.innerHTML = '<option value="">Loading providers...</option>';
        providerSelect.disabled = true;
      }
      setProviderTableMessage('Loading providers... please wait.');
      return;
    }

    populateClinicDropdownByProvider();

    setProviderTopPanelInitialState();


    refreshProviderDropdownByClinic();



    // Providers tab is now FILTER-ONLY on top.
    // Hide the old top-level assignment controls.
    if (managerSelect) managerSelect.classList.add('hidden');
    if (reporteeSelect) reporteeSelect.classList.add('hidden');
    if (saveBtn) saveBtn.classList.add('hidden');

    // Load mapped + unmapped providers by default (no provider selection required)
    await loadAssignProvidersTable();

  }

  async function loadAssignProvidersTable() {
    if (!byProviderView || !providerTableBody) return;

    if (!canScreen(ASSIGN_USERS_SCREEN_ID, 'read')) {
      showToast('You do not have permission to view Assign Users.', 'error');
      return;
    }

    // 1) Render mapped providers (top table) using the existing renderer
    // Pass empty providerId so it can render ALL (we’ll update renderProviderAssignments below)
    await renderProviderAssignments('');

    // 2) Build unmapped providers section below mapped table
    const mappedTable = providerTableBody.closest('table');
    if (!mappedTable) return;

    let unmappedWrap = document.getElementById('unmappedProvidersWrap');
    if (!unmappedWrap) {
      unmappedWrap = document.createElement('div');
      unmappedWrap.id = 'unmappedProvidersWrap';
      unmappedWrap.className = 'mt-6';
      mappedTable.insertAdjacentElement('beforebegin', unmappedWrap);
    }

    // ✅ ADD: Mapped Providers heading (must appear BELOW Unmapped Providers)
    let mappedProvidersHeading = document.getElementById('mappedProvidersHeading');
    if (!mappedProvidersHeading) {
      mappedProvidersHeading = document.createElement('div');
      mappedProvidersHeading.id = 'mappedProvidersHeading';
      mappedProvidersHeading.className = 'text-white font-semibold mb-2 mt-6';
      mappedProvidersHeading.textContent = 'Mapped Providers';
    }

    // Place it between Unmapped section and the mapped table
    unmappedWrap.insertAdjacentElement('afterend', mappedProvidersHeading);



    // Pull filters (filters only)
    const clinicIdFilter = String(clinicSelect?.value || '').trim();
    const providerIdFilter = String(providerSelect?.value || '').trim();

    // Fetch mappings so we can compute unmapped providers
    let mappings = [];
    let mappingResp = {};
    try {
      const res = await fetch('/api/platform/scribe-provider-mapping', {
        method: 'GET',
        credentials: 'include',
      });
      mappingResp = await res.json().catch(() => ({}));
      if (!res.ok || !mappingResp.ok) throw new Error(mappingResp.message || 'Failed to load mappings');
      mappings = Array.isArray(mappingResp.mappings) ? mappingResp.mappings : [];
    } catch (e) {
      console.error('loadAssignProvidersTable mappings error:', e);
      unmappedWrap.innerHTML = `<div class="text-sm text-gray-500 mt-2">Failed to load unmapped providers.</div>`;
      return;
    }

    // Which providers are already mapped?
    // Prefer global list from backend (for correct Unmapped Providers),
    // fallback to scoped mappings if backend doesn't provide it.
    const mappedProviderIds = new Set(
      Array.isArray(mappingResp.mappedProviderIdsAll)
        ? mappingResp.mappedProviderIdsAll.map(String)
        : mappings
          .map((m) => {
            const providerObjId = m?.provider && (m.provider.id ?? m.provider.user_id);
            const providerFlatId = m?.provider_user_id ?? m?.providerId ?? m?.provider_userId;
            const effectiveProviderId = providerObjId ?? providerFlatId;
            return effectiveProviderId != null ? String(effectiveProviderId) : '';
          })
          .filter(Boolean)
    );

    const providersAll = Array.isArray(assignUsersOptions.providers) ? assignUsersOptions.providers : [];

    // Unmapped providers = providers that are NOT in mappedProviderIds
    let unmappedProviders = providersAll.filter((p) => {
      const pid = String(p.id ?? p.user_id ?? '');
      return pid && !mappedProviderIds.has(pid);
    });

    // Apply filters (clinic/provider)
    if (clinicIdFilter) {
      unmappedProviders = unmappedProviders.filter((p) => {
        const provClinicId = p.clinic_id ?? p.clinicId;
        return provClinicId != null && String(provClinicId) === String(clinicIdFilter);
      });
    }
    if (providerIdFilter) {
      unmappedProviders = unmappedProviders.filter((p) => String(p.id) === String(providerIdFilter));
    }

    if (!unmappedProviders.length) {
      unmappedWrap.innerHTML = `
      <div class="text-white font-semibold mb-2">Unmapped Providers</div>
      <div class="text-sm text-gray-500 mt-2">No unmapped providers found.</div>
    `;
      return;
    }

    const canWrite = canScreen(ASSIGN_USERS_SCREEN_ID, 'write');

    // Managers list derived from scribes (same logic style you already use)
    const allScribes = Array.isArray(assignUsersOptions.scribes) ? assignUsersOptions.scribes : [];
    const managers = Array.from(
      new Set(allScribes.map(s => String(s.managerName || s.manager_name || '').trim()).filter(Boolean))
    );

    function buildManagerOptionsHtml(selected) {
      const sel = String(selected || '').trim();
      return ['<option value="">Select Manager</option>'].concat(
        managers.map(m => {
          const s = (String(m).trim() === sel) ? 'selected' : '';
          return `<option value="${escapeHtml(m)}" ${s}>${escapeHtml(m)}</option>`;
        })
      ).join('');
    }

    function buildReporteeOptionsHtml(managerName, selectedScribeId) {
      const manager = String(managerName || '').trim();
      let reportees = allScribes.filter((s) => {
        const mn = String(s.managerName || s.manager_name || '').trim();
        return manager && mn === manager;
      });
      if (!reportees.length) reportees = allScribes;

      const selId = String(selectedScribeId || '');
      return ['<option value="">Select Reportee</option>'].concat(
        reportees.map((s) => {
          const sid = s.id ?? s.user_id;
          const selected = String(sid) === selId ? 'selected' : '';
          const label = escapeHtml(formatUserDropdownLabel(s));
          return `<option value="${sid}" ${selected}>${label}</option>`;
        })
      ).join('');
    }

    // Render Unmapped Providers table
    unmappedWrap.innerHTML = `
    <div class="text-white font-semibold mb-2">Unmapped Providers</div>
    <div class="overflow-x-auto">
      <table class="w-full text-left border-collapse">
        <thead>
          <tr class="text-gray-400 border-b border-gray-700">
            <th class="py-2">Provider Name</th>
            <th class="py-2">Provider Email</th>
            <th class="py-2">Provider XR ID</th>
            <th class="py-2">Clinic</th>
            <th class="py-2">Manager</th>
            <th class="py-2">Reportee (Scribe)</th>
            <th class="py-2 text-right">Action</th>
          </tr>
        </thead>
        <tbody id="unmappedProvidersTbody">
          ${unmappedProviders.map((p) => {
      const pid = p.id ?? p.user_id;
      const pName = escapeHtmlInline(p.name || p.full_name || 'N/A');
      const pEmail = escapeHtmlInline(p.email || 'N/A');
      const pXrId = escapeHtmlInline(p.xrId || p.xr_id || 'N/A');

      const provClinicId = p.clinic_id ?? p.clinicId ?? '';
      const clinicObj = (userFormDynamicOptions.clinics || []).find(
        (c) => String(c.id) === String(provClinicId)
      );
      const clinicName = escapeHtmlInline(
        clinicObj?.clinic || clinicObj?.name || p.clinic_name || p.clinicName || 'N/A'
      );

      return `
              <tr class="border-b border-gray-800" data-unmapped-provider-id="${escapeHtmlInline(pid)}">
                <td class="py-3 text-sm">${pName}</td>
                <td class="py-3 text-sm">${pEmail}</td>
                <td class="py-3 text-sm">${pXrId}</td>

                <td class="py-3 text-sm">${clinicName}</td>

                <td class="py-3">
                  <select class="unmapped-provider-manager px-2 py-1 rounded bg-gray-700 border border-gray-600 text-white text-xs"
                          ${canWrite ? '' : 'disabled'}>
                    ${buildManagerOptionsHtml('')}
                  </select>
                </td>

                <td class="py-3">
                  <select class="unmapped-provider-reportee px-2 py-1 rounded bg-gray-700 border border-gray-600 text-white text-xs"
                          disabled
                          ${canWrite ? '' : 'disabled'}>
                    <option value="">Select manager first</option>
                  </select>
                </td>

                <td class="py-3 text-right whitespace-nowrap">
                  <button class="unmapped-provider-save px-3 py-1 rounded bg-green-600 hover:bg-green-700 text-white text-xs shrink-0"
                          ${canWrite ? '' : 'disabled'}>
                    Save
                  </button>
                </td>
              </tr>
            `;
    }).join('')}
        </tbody>
      </table>
    </div>
  `;

    const unmappedTbody = document.getElementById('unmappedProvidersTbody');
    if (!unmappedTbody) return;

    // Avoid stacking listeners
    if (!unmappedTbody.dataset.bound) {
      unmappedTbody.dataset.bound = '1';

      // Manager change → populate reportees in the same row
      unmappedTbody.addEventListener('change', (e) => {
        const mgrSel = e.target.closest('.unmapped-provider-manager');
        if (!mgrSel) return;

        const row = mgrSel.closest('tr[data-unmapped-provider-id]');
        if (!row) return;

        const reporteeSel = row.querySelector('.unmapped-provider-reportee');
        if (!reporteeSel) return;

        const managerName = mgrSel.value;
        reporteeSel.innerHTML = buildReporteeOptionsHtml(managerName, '');
        reporteeSel.disabled = !managerName;
      });

      // Save mapping
      unmappedTbody.addEventListener('click', async (e) => {
        const btn = e.target.closest('.unmapped-provider-save');
        if (!btn) return;

        if (!canScreen(ASSIGN_USERS_SCREEN_ID, 'write')) {
          showToast('You only have READ permission for Assign Users. Editing is not allowed.', 'error');
          return;
        }

        const row = btn.closest('tr[data-unmapped-provider-id]');
        if (!row) return;

        const providerId = row.getAttribute('data-unmapped-provider-id');
        const reporteeSel = row.querySelector('.unmapped-provider-reportee');
        const scribeId = reporteeSel ? reporteeSel.value : '';

        const providerIdNum = Number(providerId);
        const scribeIdNum = Number(scribeId);

        if (!Number.isFinite(providerIdNum) || providerIdNum <= 0 || !Number.isFinite(scribeIdNum) || scribeIdNum <= 0) {
          showToast('Please select Manager and Reportee before saving.', 'error');
          return;
        }

        try {
          btn.disabled = true;
          btn.textContent = 'Saving...';

          const res = await fetch('/api/platform/scribe-provider-mapping', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
              scribeUserId: scribeIdNum,
              providerUserId: providerIdNum,
            }),
          });

          const out = await res.json().catch(() => ({}));
          if (!res.ok || !out.ok) throw new Error(out.message || 'Failed to save assignment');

          showToast(out.message || 'Assignment saved', 'success');

          // refresh providers tab view
          await loadAssignProvidersTable();

        } catch (err) {
          console.error('Unmapped provider save error:', err);
          showToast(err.message || 'Failed to save assignment', 'error');
        } finally {
          btn.disabled = !canScreen(ASSIGN_USERS_SCREEN_ID, 'write');
          btn.textContent = 'Save';
        }
      });
    }
  }



  async function renderProviderAssignments(providerId) {
    if (!providerTableBody) return;


    try {
      const res = await fetch('/api/platform/scribe-provider-mapping', {
        method: 'GET',
        credentials: 'include',
      });

      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.message || 'Failed to load mappings');

      const mappings = Array.isArray(data.mappings) ? data.mappings : [];

      // Top dropdowns are FILTERS ONLY now
      const clinicIdFilter = String(clinicSelect?.value || '').trim();
      const providerIdFilter = String(providerSelect?.value || '').trim();

      // If providerId param is passed (older path), honor it.
      // Otherwise show ALL (new default).
      const explicitProviderId = providerId ? String(providerId).trim() : '';

      // Helper to get provider id from mapping (supports both object and flat shapes)
      const getMappingProviderId = (m) => {
        const providerObjId = m.provider && (m.provider.id ?? m.provider.user_id);
        const providerFlatId = m.provider_user_id ?? m.providerId ?? m.provider_userId;
        return providerObjId ?? providerFlatId;
      };

      // Helper to get clinic id from mapping/provider
      const getMappingClinicId = (m) => {
        const p = m.provider || {};
        return p.clinic_id ?? p.clinicId ?? m.clinic_id ?? m.clinicId;
      };

      let filtered = mappings;

      // 1) If providerId param was provided, filter by it (backward compatible)
      if (explicitProviderId) {
        filtered = filtered.filter((m) => String(getMappingProviderId(m)) === explicitProviderId);
      }

      // 2) Apply Provider dropdown filter (if selected)
      if (providerIdFilter) {
        filtered = filtered.filter((m) => String(getMappingProviderId(m)) === String(providerIdFilter));
      }

      // 3) Apply Clinic dropdown filter (if selected)
      if (clinicIdFilter) {
        filtered = filtered.filter((m) => String(getMappingClinicId(m)) === String(clinicIdFilter));
      }


      if (!filtered.length) {
        setProviderTableMessage('No mapped providers found for the selected filters.');

        return;
      }

      const allScribes = Array.isArray(assignUsersOptions.scribes)
        ? assignUsersOptions.scribes
        : [];

      // Build scribe options based on managerName (reportees under that manager)
      function buildScribeOptionsHtml(managerName, selectedScribeId) {
        const manager = String(managerName || '').trim();

        let scribesForManager = allScribes.filter((s) => {
          const mn = String(s.managerName || s.manager_name || '').trim();
          return manager && mn && mn === manager;
        });

        // Fallback: if no manager match, show all scribes (prevents empty dropdown)
        if (!scribesForManager.length) scribesForManager = allScribes;

        return scribesForManager.map((s) => {
          const sid = s.id ?? s.user_id;
          const selected = String(sid) === String(selectedScribeId) ? 'selected' : '';
          const label = escapeHtml(formatUserDropdownLabel(s));
          return `<option value="${sid}" ${selected}>${label}</option>`;
        }).join('');
      }

      // Build Manager dropdown options (unique manager names)
      function buildManagerOptionsHtml(selectedManagerName) {
        const managers = Array.from(
          new Set(
            allScribes
              .map(s => String(s.managerName || s.manager_name || '').trim())
              .filter(Boolean)
          )
        );

        const sel = String(selectedManagerName || '').trim();

        const options = ['<option value="">Select Manager</option>'].concat(
          managers.map((m) => {
            const selected = (String(m).trim() === sel) ? 'selected' : '';
            return `<option value="${escapeHtml(m)}" ${selected}>${escapeHtml(m)}</option>`;
          })
        );

        return options.join('');
      }

      // Build Reportee dropdown options filtered by chosen manager
      function buildReporteeOptionsHtml(managerName, selectedScribeId) {
        const manager = String(managerName || '').trim();

        let reportees = allScribes.filter((s) => {
          const mn = String(s.managerName || s.manager_name || '').trim();
          return manager && mn && mn === manager;
        });

        // fallback safety so dropdown never becomes empty
        if (!reportees.length) reportees = allScribes;

        const options = ['<option value="">Select Reportee</option>'].concat(
          reportees.map((s) => {
            const sid = s.id ?? s.user_id;
            const selected = String(sid) === String(selectedScribeId) ? 'selected' : '';
            const label = escapeHtml(formatUserDropdownLabel(s));
            return `<option value="${sid}" ${selected}>${label}</option>`;
          })
        );

        return options.join('');
      }


      const canWrite = canScreen(ASSIGN_USERS_SCREEN_ID, 'write');

      providerTableBody.innerHTML = filtered.map((m) => {
        const s = m.scribe || {};
        const p = m.provider || {};

        const providerIdForRow = getMappingProviderId(m);

        const pName = escapeHtml(p.name || p.full_name || 'N/A');
        const pEmail = escapeHtml(p.email || 'N/A');
        const pXrId = escapeHtml(p.xrId || p.xr_id || 'N/A');
        // ✅ Clinic name lookup (provider usually has only clinic_id / clinicId)
        const provClinicId = p.clinic_id ?? p.clinicId ?? p.clinic;

        const clinicObj = (userFormDynamicOptions.clinics || []).find(
          (c) => String(c.id) === String(provClinicId)
        );

        const clinicName = escapeHtml(

          clinicObj?.clinic || clinicObj?.name ||
          p.clinic_name ||     // fallback if backend sends it
          p.clinicName ||      // fallback if backend sends it
          'N/A'
        );


        const sName = escapeHtml(s.name || s.full_name || 'N/A');
        const sEmail = escapeHtml(s.email || 'N/A');
        const sXrId = escapeHtml(s.xrId || s.xr_id || 'N/A');

        const managerName = escapeHtml(s.managerName || s.manager_name || 'N/A');

        return `
<tr class="table-row border-b border-gray-700"
    data-scribe-id="${escapeHtml(s.id)}"
    data-provider-id="${escapeHtml(providerIdForRow)}"
    data-orig-manager="${escapeHtml(s.managerName || s.manager_name || '')}"
    data-orig-scribe="${escapeHtml(s.id)}">

  <td class="py-3">${pName}</td>
  <td class="py-3 text-sm">${pEmail}</td>
  <td class="py-3">
    <span class="px-2 py-1 text-xs rounded-full bg-blue-500 bg-opacity-20 text-blue-400">${pXrId}</span>
  </td>
  <td class="py-3 text-sm">${clinicName}</td>

  <!-- Scribe Name (VIEW text + EDIT dropdown in SAME cell) -->
  <td class="py-3">
    <span class="provider-view-scribe">${sName}</span>

    <select class="provider-edit-scribe hidden px-2 py-1 rounded bg-gray-700 border border-gray-600 text-white text-xs
                   w-56 max-w-[240px] min-w-0 truncate"
            data-action="provider-row-reportee"
            ${canWrite ? '' : 'disabled'}>
      ${buildReporteeOptionsHtml(s.managerName || s.manager_name || '', s.id)}
    </select>
  </td>

  <td class="py-3 text-sm">${sEmail}</td>
  <td class="py-3">
    <span class="px-2 py-1 text-xs rounded-full bg-blue-500 bg-opacity-20 text-blue-400">${sXrId}</span>
  </td>

  <!-- Scribe Manager (VIEW text + EDIT dropdown in SAME cell) -->
  <td class="py-3 text-sm">
    <span class="provider-view-manager">${managerName}</span>

    <select class="provider-edit-manager hidden px-2 py-1 rounded bg-gray-700 border border-gray-600 text-white text-xs
                   w-32 max-w-[140px] min-w-0 truncate"
            data-action="provider-row-manager"
            ${canWrite ? '' : 'disabled'}>
      ${buildManagerOptionsHtml(s.managerName || s.manager_name || '')}
    </select>
  </td>

  <!-- Actions (ONLY buttons now) -->
  <td class="py-3 text-sm whitespace-nowrap">
    <div class="flex items-center gap-2 justify-end">
      <button class="provider-inline-edit px-2 py-1 rounded bg-blue-600 hover:bg-blue-700 text-white text-xs"
              data-action="provider-row-edit"
              ${canWrite ? '' : 'disabled'}>
        Edit
      </button>

      <button class="provider-inline-save hidden px-2 py-1 rounded bg-green-600 hover:bg-green-700 text-white text-xs"
              data-action="provider-row-save"
              ${canWrite ? '' : 'disabled'}>
        Save
      </button>

      <button class="provider-inline-cancel hidden px-2 py-1 rounded bg-gray-600 hover:bg-gray-700 text-white text-xs"
              data-action="provider-row-cancel"
              ${canWrite ? '' : 'disabled'}>
        Cancel
      </button>
    </div>
  </td>

</tr>
`;

      }).join('');

    } catch (err) {
      console.error('Provider view load error:', err);
      setProviderTableMessage('Failed to load provider assignments.');
      showToast(err.message || 'Failed to load provider assignments', 'error');
    }
  }



  resetManagerAndReportee();


  if (managerSelect) {
    managerSelect.onchange = refreshReporteesByManager;
  }

  // Provider table row edit/save/cancel (bind once)
  if (providerTableBody && !providerTableBody.dataset.providerRowBound) {
    providerTableBody.dataset.providerRowBound = '1';

    // Change manager -> refresh reportees inside the SAME row
    providerTableBody.addEventListener('change', (e) => {
      const managerSel = e.target.closest('select[data-action="provider-row-manager"]');
      if (!managerSel) return;

      const row = managerSel.closest('tr[data-scribe-id]');
      if (!row) return;

      const reporteeSel = row.querySelector('select[data-action="provider-row-reportee"]');
      if (!reporteeSel) return;

      const managerName = String(managerSel.value || '').trim();

      const allScribes = Array.isArray(assignUsersOptions.scribes) ? assignUsersOptions.scribes : [];
      let reportees = allScribes.filter((s) => {
        const mn = String(s.managerName || s.manager_name || '').trim();
        return managerName && mn === managerName;
      });
      if (!reportees.length) reportees = allScribes;

      reporteeSel.innerHTML =
        '<option value="">Select Reportee</option>' +
        reportees.map((s) => {
          const sid = s.id ?? s.user_id;
          const label = escapeHtml(formatUserDropdownLabel(s));
          return `<option value="${sid}">${label}</option>`;
        }).join('');
    });

    providerTableBody.addEventListener('click', async (e) => {
      const row = e.target.closest('tr[data-scribe-id]');
      if (!row) return;

      // EDIT
      const editBtn = e.target.closest('[data-action="provider-row-edit"]');
      if (editBtn) {
        // show dropdowns in-place
        row.querySelector('.provider-view-scribe')?.classList.add('hidden');
        row.querySelector('.provider-view-manager')?.classList.add('hidden');

        row.querySelector('.provider-edit-scribe')?.classList.remove('hidden');
        row.querySelector('.provider-edit-manager')?.classList.remove('hidden');

        // show save/cancel, hide edit
        row.querySelector('[data-action="provider-row-save"]')?.classList.remove('hidden');
        row.querySelector('[data-action="provider-row-cancel"]')?.classList.remove('hidden');
        editBtn.classList.add('hidden');
        return;
      }


      // CANCEL
      const cancelBtn = e.target.closest('[data-action="provider-row-cancel"]');
      if (cancelBtn) {
        const origManager = row.dataset.origManager || '';
        const origScribeId = row.dataset.origScribe || '';

        const managerSel = row.querySelector('select[data-action="provider-row-manager"]');
        const reporteeSel = row.querySelector('select[data-action="provider-row-reportee"]');

        if (managerSel) managerSel.value = origManager;

        // rebuild reportee list for original manager and select original scribe
        if (reporteeSel) {
          const allScribes = Array.isArray(assignUsersOptions.scribes) ? assignUsersOptions.scribes : [];
          let reportees = allScribes.filter((s) => {
            const mn = String(s.managerName || s.manager_name || '').trim();
            return origManager && mn === origManager;
          });
          if (!reportees.length) reportees = allScribes;

          reporteeSel.innerHTML =
            '<option value="">Select Reportee</option>' +
            reportees.map((s) => {
              const sid = s.id ?? s.user_id;
              const selected = String(sid) === String(origScribeId) ? 'selected' : '';
              const label = escapeHtml(formatUserDropdownLabel(s));
              return `<option value="${sid}" ${selected}>${label}</option>`;
            }).join('');
        }

        // hide dropdowns
        row.querySelector('.provider-edit-scribe')?.classList.add('hidden');
        row.querySelector('.provider-edit-manager')?.classList.add('hidden');

        // show view text
        row.querySelector('.provider-view-scribe')?.classList.remove('hidden');
        row.querySelector('.provider-view-manager')?.classList.remove('hidden');

        // hide save/cancel, show edit
        row.querySelector('[data-action="provider-row-save"]')?.classList.add('hidden');
        row.querySelector('[data-action="provider-row-cancel"]')?.classList.add('hidden');
        row.querySelector('[data-action="provider-row-edit"]')?.classList.remove('hidden');

        return;
      }


      // SAVE
      const saveRowBtn = e.target.closest('[data-action="provider-row-save"]');
      if (saveRowBtn) {
        if (!canScreen(ASSIGN_USERS_SCREEN_ID, 'write')) {
          showToast('You only have READ permission for Assign Users. Editing is not allowed.', 'error');
          return;
        }

        // Provider must come from the row now (top Provider filter may be empty)
        const providerId = row.dataset.providerId || (providerSelect ? providerSelect.value : '');

        const reporteeSel = row.querySelector('select[data-action="provider-row-reportee"]');
        const newScribeId = reporteeSel ? reporteeSel.value : '';

        if (!providerId || !newScribeId) {
          showToast('Select manager + reportee before saving.', 'error');
          return;
        }

        try {
          saveRowBtn.disabled = true;
          const oldText = saveRowBtn.textContent;
          saveRowBtn.textContent = 'Saving...';

          const res = await fetch('/api/platform/scribe-provider-mapping', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
              scribeUserId: Number(newScribeId),
              providerUserId: Number(providerId),
            }),
          });

          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data.ok) throw new Error(data.message || 'Failed to update mapping');

          showToast('Mapping updated', 'success');

          // refresh Providers tab (mapped + unmapped) so the row moves correctly
          await loadAssignProvidersTable();


        } catch (err) {
          console.error('Provider row save error:', err);
          showToast(err.message || 'Failed to update mapping', 'error');
        } finally {
          saveRowBtn.disabled = false;
          saveRowBtn.textContent = 'Save';
        }
      }
    });
  }



  if (saveBtn) {
    saveBtn.onclick = async () => {
      if (!canScreen(ASSIGN_USERS_SCREEN_ID, 'write')) {
        showToast('You only have READ permission for Assign Users. Editing is not allowed.', 'error');
        return;
      }

      const providerId = providerSelect ? providerSelect.value : '';
      const scribeId = reporteeSelect ? reporteeSelect.value : '';

      if (!providerId || !scribeId) {
        showToast('Please select Clinic → Provider → Manager → Reportee before saving.', 'error');
        return;
      }

      try {
        saveBtn.disabled = true;
        const oldText = saveBtn.textContent;
        saveBtn.textContent = 'Saving...';

        const res = await fetch('/api/platform/scribe-provider-mapping', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            scribeUserId: Number(scribeId),
            providerUserId: Number(providerId),
          }),
        });

        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.message || 'Failed to save assignment');

        showToast(data.message || 'Assignment saved', 'success');

        // refresh both views for consistency
        await loadAssignUsersTable();
        await renderProviderAssignments(providerId);

        // optional: reset reportee select after save
        if (reporteeSelect) {
          reporteeSelect.value = '';
        }

        saveBtn.textContent = oldText;
      } catch (err) {
        console.error('Provider Save Assignment error:', err);
        showToast(err.message || 'Failed to save assignment', 'error');
      } finally {
        saveBtn.disabled = !canScreen(ASSIGN_USERS_SCREEN_ID, 'write');
        saveBtn.textContent = 'Save Assignment';
      }
    };
  }


  byScribeBtn.onclick = showScribeView;
  byProviderBtn.onclick = showProviderView;

  // Default = existing flow unchanged
  showScribeView();
}



function showError(message) {
  errorMessage.textContent = message;
  errorMessage.classList.remove('hidden');
  setTimeout(() => {
    errorMessage.classList.add('hidden');
  }, 5000);
}

if (loginForm) {
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;

    if (!email || !password) {
      showError('Please enter both email and password');
      return;
    }

    loginBtn.disabled = true;
    loginBtn.textContent = 'Signing in...';
    errorMessage.classList.add('hidden');

    try {
      const response = await fetch('/api/platform/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password }),
      });

      const data = await response.json();

      if (response.ok && data.ok) {
        currentUser = data;
        await showDashboard(data.email);
        document.getElementById('email').value = '';
        document.getElementById('password').value = '';


        // After login, load lookup options ONLY for SuperAdmin
        if (isCurrentUserSuperAdmin() && typeof refreshCreateUserFormOptionsGlobal === 'function') {
          refreshCreateUserFormOptionsGlobal();
        }
      } else {
        showError(data.message || 'Login failed. Please check your credentials.');
      }
    } catch (err) {
      console.error('Login error:', err);
      showError('Connection error. Please try again.');
    } finally {
      loginBtn.disabled = false;
      loginBtn.textContent = 'Sign In';
    }
  });
}


if (logoutBtn) {
  logoutBtn.addEventListener('click', async () => {
    try {
      await fetch('/api/platform/logout', {
        method: 'POST',
        credentials: 'include',
      });
      currentUser = null;
      showLoginForm();
    } catch (err) {
      console.error('Logout error:', err);
      showLoginForm();
    }
  });
}

function switchView(viewName) {
  document.querySelectorAll('.view-content').forEach(view => {
    view.classList.add('hidden');
  });

  document.querySelectorAll('.sidebar-item').forEach(item => {
    item.classList.remove('active');
  });

  const targetView = document.getElementById(`view-${viewName}`);
  const targetButton = document.querySelector(`[data-view="${viewName}"]`);

  if (targetView) {
    targetView.classList.remove('hidden');
    targetView.classList.add('fade-in');
  }

  if (targetButton) {
    targetButton.classList.add('active');
  }

  if (viewName === 'dashboard') {
    loadDashboardStats();
  } else if (viewName === 'assign-users') {
    // Assign Users:
    // 1) load clinics (for clinic filter)
    // 2) load scribe/provider options
    // 3) init top panel (scribe / clinic / provider dropdowns)
    // 4) render table (unchanged)
    Promise.all([
      loadUserFormOptions(),      // fills userFormDynamicOptions.clinics
      loadAssignUsersOptions(),   // fills assignUsersOptions.scribes/providers
    ]).then(() => {
      initAssignUsersTopPanel();  // uses both of the above
      initAssignUsersDualView();  // NEW: enables By Scribe / By Provider toggle
      loadAssignUsersTable();     // existing table logic
    }).catch((err) => {
      console.error('assign-users init error:', err);
      // Fail-open: still try to render table even if lookups failed
      loadAssignUsersTable();
    });
  }

}


document.querySelectorAll('.sidebar-item').forEach(item => {
  item.addEventListener('click', () => {
    const viewName = item.getAttribute('data-view');
    switchView(viewName);
  });
});

async function loadDashboardStats() {
  try {
    const response = await fetch('/api/platform/stats', {
      method: 'GET',
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error('Failed to load stats');
    }

    const data = await response.json();

    if (data.ok && data.stats) {
      const stats = data.stats;

      document.getElementById('totalUsers').textContent = stats.totalUsers || 0;
      document.getElementById('totalProviders').textContent = stats.totalProviders || 0;
      document.getElementById('totalScribes').textContent = stats.totalScribes || 0;
      document.getElementById('totalEmployees').textContent = stats.totalEmployees || 0;

      const recentLoginsTable = document.getElementById('recentLoginsTable');
      if (stats.recentLogins && stats.recentLogins.length > 0) {
        recentLoginsTable.innerHTML = stats.recentLogins.map(login => `
          <tr class="table-row border-b border-gray-700">
            <td class="py-3">${login.name || 'N/A'}</td>
            <td class="py-3">${login.email || 'N/A'}</td>
            <td class="py-3">${login.xrId || 'N/A'}</td>
            <td class="py-3">
              <span class="px-2 py-1 text-xs rounded-full bg-blue-500 bg-opacity-20 text-blue-400">
                ${login.userType || 'N/A'}
              </span>
            </td>
            <td class="py-3 text-sm text-gray-400">
              ${login.lastLogin ? new Date(login.lastLogin).toLocaleString() : 'Never'}
            </td>
          </tr>
        `).join('');
      } else {
        recentLoginsTable.innerHTML = `
          <tr>
            <td colspan="5" class="py-8 text-center text-gray-500">No recent logins</td>
          </tr>
        `;
      }
    }
  } catch (err) {
    console.error('Failed to load dashboard stats:', err);
    showToast('Failed to load dashboard statistics', 'error');
  }
}

// ===== Dynamic Create-User Form behaviour =====

const createUserForm = document.getElementById('createUserForm');
const userCategorySelect = document.getElementById('userCategory');
const userFormDynamicFields = document.getElementById('userFormDynamicFields');

if (createUserForm && userCategorySelect && userFormDynamicFields) {

  // Decide whether a screen is an XR "screen module" vs a "menu module"
  function isScreenModule(screen) {
    const name = (screen.name || '').toLowerCase();

    // Treat these as XR Screen Modules
    const xrNames = [
      'xr hub dashboard',
      'xr dock',
      'xr vision dock',
      'xr device'
    ];

    return xrNames.some(n => name.includes(n));
  }

  // create one field element from our config
  function renderField(field) {
    const wrapper = document.createElement('div');
    wrapper.className = 'field';

    const label = document.createElement('label');
    label.textContent = field.label;
    label.htmlFor = field.name;
    label.className = 'block text-sm text-gray-300 mb-1';
    wrapper.appendChild(label);

    //
    // 1) Special case: Screen rights checkbox group
    //
    //
    // 1) Special case: checkbox group fields
    //
    if (field.type === 'checkbox-group') {
      const options =
        field.options ||
        (field.optionsKey ? (userFormDynamicOptions[field.optionsKey] || []) : []);


      // 1a) Screen Access (rights) -> split into XR Screen Modules & Menu Modules,
      //     with per-screen Read / Write / Edit / Delete checkboxes
      //
      if (field.name === 'rights' && field.optionsKey === 'screens') {
        const xrScreens = [];
        const menuScreens = [];

        options.forEach((opt) => {
          const screenObj =
            typeof opt === 'string'
              ? { id: opt, name: opt }
              : opt;

          if (isScreenModule(screenObj)) {
            xrScreens.push(screenObj);
          } else {
            menuScreens.push(screenObj);
          }
        });

        const group = document.createElement('div');
        group.className = 'flex flex-col gap-3';

        // Helper to build one column (XR or Menu)
        function buildScreenColumn(title, screens) {
          const column = document.createElement('div');

          const heading = document.createElement('div');
          heading.className = 'text-xs font-semibold text-gray-400 mb-1';
          heading.textContent = title;
          column.appendChild(heading);

          const list = document.createElement('div');
          list.className =
            'space-y-1 bg-slate-900/50 p-3 rounded border border-slate-700 max-h-48 overflow-y-auto';

          screens.forEach((opt) => {
            const screenId = opt.id;

            const row = document.createElement('div');
            row.className =
              'flex items-center justify-between py-1 px-2 rounded hover:bg-slate-800/50';

            // LEFT: main checkbox + label
            const left = document.createElement('label');
            left.className = 'flex items-center space-x-2 cursor-pointer';

            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.name = field.name; // "rights"
            cb.value = screenId;
            cb.className =
              'h-4 w-4 rounded border-slate-600 bg-slate-800 text-purple-500 focus:ring-purple-400';

            const span = document.createElement('span');
            span.textContent = opt.name;
            span.className = 'text-sm text-gray-200';

            left.appendChild(cb);
            left.appendChild(span);

            // RIGHT: R/W/E/D checkboxes (initially disabled until main cb is checked)
            const perms = document.createElement('div');
            perms.className =
              'flex items-center space-x-3 text-[11px] text-gray-300 opacity-40 pointer-events-none';

            ['read', 'write', 'edit', 'delete'].forEach((perm) => {
              const permLabel = document.createElement('label');
              permLabel.className = 'flex items-center space-x-1';

              const permCB = document.createElement('input');
              permCB.type = 'checkbox';
              permCB.dataset.permission = perm;
              permCB.dataset.screenId = String(screenId);
              permCB.className =
                'h-3 w-3 rounded border-slate-600 bg-slate-800 text-purple-400 focus:ring-purple-300';

              const permSpan = document.createElement('span');
              permSpan.textContent = perm.charAt(0).toUpperCase();
              permSpan.title = perm; // tooltip

              permLabel.appendChild(permCB);
              permLabel.appendChild(permSpan);
              perms.appendChild(permLabel);
            });

            // Enable / disable perms when main checkbox changes
            cb.addEventListener('change', () => {
              if (cb.checked) {
                perms.classList.remove('opacity-40', 'pointer-events-none');
              } else {
                perms.classList.add('opacity-40', 'pointer-events-none');
                perms.querySelectorAll('input[type="checkbox"]').forEach((p) => {
                  p.checked = false;
                });
              }
            });

            row.appendChild(left);
            row.appendChild(perms);
            list.appendChild(row);
          });

          column.appendChild(list);
          return column;
        }

        const xrColumn = buildScreenColumn('XR Screen Modules', xrScreens);
        const menuColumn = buildScreenColumn('Menu Modules', menuScreens);

        group.appendChild(xrColumn);
        group.appendChild(menuColumn);

        wrapper.appendChild(group);
        return wrapper;
      }


      //
      // 1b) Default checkbox-group (unchanged behaviour)
      //
      const group = document.createElement('div');
      group.className =
        'space-y-1 bg-slate-900/50 p-3 rounded border border-slate-700';

      options.forEach(opt => {
        const value = typeof opt === 'string' ? opt : opt.id;
        const labelText = typeof opt === 'string' ? opt : opt.name;

        const row = document.createElement('label');
        row.className =
          'flex items-center space-x-2 py-1 px-2 rounded hover:bg-slate-800/50 cursor-pointer';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.name = field.name;
        cb.value = value;
        cb.className =
          'h-4 w-4 rounded border-slate-600 bg-slate-800 text-purple-500 focus:ring-purple-400';

        const span = document.createElement('span');
        span.textContent = labelText;
        span.className = 'text-sm text-gray-200';

        row.appendChild(cb);
        row.appendChild(span);
        group.appendChild(row);
      });

      wrapper.appendChild(group);
      return wrapper;
    }

    //
    // 2) Normal select field
    //
    let input;
    if (field.type === 'select') {
      input = document.createElement('select');
      input.className =
        'w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-gray-100';

      const options =
        field.options ||
        (field.optionsKey ? (userFormDynamicOptions[field.optionsKey] || []) : []);

      options.forEach(opt => {
        const o = document.createElement('option');
        if (typeof opt === 'string') {
          o.value = opt;
          o.textContent = opt;
        } else {
          o.value = opt.id;
          o.textContent = opt.name;
        }
        input.appendChild(o);
      });
    } else {
      //
      // 3) Default input field (text/password)
      //
      input = document.createElement('input');
      input.type = field.type || 'text';
      input.className =
        'w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-gray-100';
    }

    input.id = field.name;
    input.name = field.name;
    if (field.required) input.required = true;

    wrapper.appendChild(input);
    return wrapper;



  }

  // ===== Helpers for dynamic Primary Provider dropdown (Scribe only) =====

  // Actually call the backend and fill the Primary Provider <select>
  async function loadProvidersForClinicDropdown(clinicId, providerSelectEl) {
    if (!providerSelectEl) return;

    // Basic "loading..." state
    providerSelectEl.disabled = true;
    providerSelectEl.innerHTML = '';
    const loadingOpt = document.createElement('option');
    loadingOpt.value = '';
    loadingOpt.textContent = 'Loading providers...';
    providerSelectEl.appendChild(loadingOpt);

    if (!clinicId) {
      providerSelectEl.innerHTML = '';
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'Select clinic first';
      providerSelectEl.appendChild(opt);
      providerSelectEl.disabled = true;
      return;
    }

    try {
      const res = await fetch(`/api/platform/providers?clinicId=${encodeURIComponent(clinicId)}`, {
        method: 'GET',
        credentials: 'include',
      });

      if (!res.ok) {
        throw new Error('Request failed with status ' + res.status);
      }

      const data = await res.json();

      const providers = Array.isArray(data.providers) ? data.providers : [];

      // Optionally keep a copy in case you ever need it elsewhere
      userFormDynamicOptions.providers = providers.map(p => ({
        id: p.id,
        name: p.full_name || p.name || `Provider ${p.id}`,
      }));

      providerSelectEl.innerHTML = '';

      if (!providers.length) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'No providers for this clinic';
        providerSelectEl.appendChild(opt);
        providerSelectEl.disabled = true;
        return;
      }

      const defaultOpt = document.createElement('option');
      defaultOpt.value = '';
      defaultOpt.textContent = 'Select Primary Provider';
      providerSelectEl.appendChild(defaultOpt);

      providers.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.full_name || p.name || `Provider ${p.id}`;
        providerSelectEl.appendChild(opt);
      });

      providerSelectEl.disabled = false;
    } catch (err) {
      console.error('Error loading providers for clinic', err);
      providerSelectEl.innerHTML = '';
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'Error loading providers';
      providerSelectEl.appendChild(opt);
      providerSelectEl.disabled = true;
    }
  }

  // Set up clinic → providers behaviour for the Scribe category
  function setupScribeProviderBehaviour(category) {
    if (category !== USER_CATEGORY.SCRIBE) {
      return; // Only applies to Scribes
    }

    const clinicEl = createUserForm.querySelector('[name="clinic"]');
    const providerEl = createUserForm.querySelector('[name="primaryProviderId"]');

    if (!clinicEl || !providerEl) return;

    // Initial placeholder
    providerEl.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Select clinic first';
    providerEl.appendChild(placeholder);
    providerEl.disabled = true;

    // When clinic changes, reload providers
    clinicEl.addEventListener('change', () => {
      const clinicId = clinicEl.value;
      if (!clinicId) {
        providerEl.innerHTML = '';
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'Select clinic first';
        providerEl.appendChild(opt);
        providerEl.disabled = true;
        return;
      }
      loadProvidersForClinicDropdown(clinicId, providerEl);
    });

    // If a clinic is already selected (e.g. user picked it before),
    // immediately load providers for that clinic.
    if (clinicEl.value) {
      loadProvidersForClinicDropdown(clinicEl.value, providerEl);
    }
  }


  // rebuild the fields whenever category changes
  function renderFormForCategory(category) {
    const role = getCreatorRole();
    const config = getFormConfigForCategory(category, role);
    if (!config) return;

    userFormDynamicFields.innerHTML = '';

    config.formFields.forEach(field => {

      // Scribe: do not show Clinic or Primary Provider at create time
      if (
        category === USER_CATEGORY.SCRIBE &&
        (field.name === 'clinic' || field.name === 'primaryProviderId')
      ) {
        return;
      }

      const fieldEl = renderField(field);
      userFormDynamicFields.appendChild(fieldEl);
    });

    // NEW: after fields are created, wire up dynamic Primary Provider dropdown
    if (category === USER_CATEGORY.SCRIBE) {
      setupScribeProviderBehaviour(category);
    }

  }

  // On category change -> rebuild fields
  userCategorySelect.addEventListener('change', function (e) {
    renderFormForCategory(e.target.value);
  });

  // Helper: load lookup options from backend and then render the form
  async function refreshCreateUserFormOptions() {
    try {
      await loadUserFormOptions();     // loads clinics + screens
    } catch (err) {
      console.error('Failed to load form options:', err);
    }
    renderFormForCategory(userCategorySelect.value);
  }

  // Make this available to login/session code
  refreshCreateUserFormOptionsGlobal = refreshCreateUserFormOptions;

  // Auto-refresh only if session already exists
  if (currentUser) {
    refreshCreateUserFormOptions();
  }

  // Refresh every time they open Create Users
  const createUsersSidebarItem = document.querySelector('[data-view="create-users"]');
  if (createUsersSidebarItem) {
    createUsersSidebarItem.addEventListener('click', () => {
      refreshCreateUserFormOptions();
    });
  }

  // Submit handler: send data to backend
  createUserForm.addEventListener('submit', async function (e) {
    e.preventDefault();

    // System_Screens.id for "Create User" screen
    const CREATE_USER_SCREEN_ID = 6; // adjust if your DB uses a different id

    // 🔒 If user only has READ (or no rights) on this screen, block writes
    if (!canScreen(CREATE_USER_SCREEN_ID, 'write')) {
      showToast('You only have READ permission for Create User. Editing is not allowed.', 'error');
      return;
    }

    const category = userCategorySelect.value;
    const role = getCreatorRole();
    const config = getFormConfigForCategory(category, role);
    const userData = { category };


    //
    // Collect inputs AND checkbox groups (screen rights)
    //
    config.formFields.forEach(field => {

      // 1) Screen-rights checkboxes (extended with R/W/E/D)
      if (field.type === 'checkbox-group') {
        // Only special-case the "rights" field; any other checkbox-groups (if added later)
        // will still use the old behaviour.
        if (field.name === 'rights') {
          const selectedScreens = Array.from(
            createUserForm.querySelectorAll('input[name="rights"]:checked')
          );

          userData.rights = selectedScreens.map((cb) => {
            const screenId = Number(cb.value);

            // Find all permission checkboxes for this screen
            const perms = Array.from(
              createUserForm.querySelectorAll(
                `input[data-screen-id="${screenId}"][data-permission]`
              )
            );

            const permObj = { screenId };

            perms.forEach((p) => {
              permObj[p.dataset.permission] = p.checked ? 1 : 0;
            });

            return permObj;
          });

          return; // important: skip normal input processing
        }

        // Fallback for any other checkbox-group fields (if you add them in future)
        const checkedBoxes = Array.from(
          createUserForm.querySelectorAll(`input[name="${field.name}"]:checked`)
        );
        userData[field.name] = checkedBoxes.map((cb) => cb.value);
        return;
      }


      // 2) Normal <input> or <select>
      const el = createUserForm.querySelector('[name="' + field.name + '"]');
      if (!el) return;

      userData[field.name] = el.value;
    });

    // Scribe: allow empty clinic/provider (assigned later via Assign Users)
    if (category === USER_CATEGORY.SCRIBE) {
      if (!userData.clinic) delete userData.clinic;
      if (!userData.primaryProviderId) delete userData.primaryProviderId;
    }



    // For Manager creating Scribe/Employee: reporting manager auto-assign
    if (
      (category === USER_CATEGORY.SCRIBE || category === USER_CATEGORY.EMPLOYEE) &&
      role === 'manager' &&
      !userData.reportingManagerId
    ) {
      userData.reportingManagerId = currentUser && currentUser.id;
    }

    // Map category to userType string to match backend
    const userTypeMap = {
      [USER_CATEGORY.PROVIDER]: 'Provider',
      [USER_CATEGORY.SCRIBE]: 'Scribe',
      [USER_CATEGORY.EMPLOYEE]: 'Employee',
      [USER_CATEGORY.PATIENT]: 'Patient', // ✅ ADD THIS
    };
    userData.userType = userTypeMap[category];

    try {
      const response = await fetch('/api/platform/create-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(userData),
      });

      const data = await response.json();

      if (response.ok && data.ok) {
        showToast('User created successfully!', 'success');
        createUserForm.reset();
        renderFormForCategory(userCategorySelect.value);
        loadDashboardStats();
      } else {
        showToast(data.message || 'Failed to create user', 'error');
      }
    } catch (err) {
      console.error('Create user error:', err);
      showToast('Connection error. Please try again.', 'error');
    }
  });
}




if (createLoginUserForm) {
  createLoginUserForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const name = document.getElementById('loginName').value.trim();
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    const reportingManager = document
      .getElementById('loginReportingManager')
      .value.trim();

    if (!name || !email || !password) {
      createLoginUserMessage.textContent =
        'Name, email, and password are required.';
      createLoginUserMessage.classList.remove('hidden');
      createLoginUserMessage.classList.remove('text-green-400');
      createLoginUserMessage.classList.add('text-red-400');
      return;
    }

    createLoginUserButton.disabled = true;
    createLoginUserButton.textContent = 'Creating...';
    createLoginUserMessage.classList.add('hidden');

    try {
      const res = await fetch('/api/auth/create-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name,
          email,
          password,
          reportingManager,
        }),
      });

      const data = await res.json();

      if (!res.ok || !data.ok) {
        throw new Error(data.message || 'Failed to create login user');
      }

      createLoginUserMessage.textContent =
        'Login user created successfully.';
      createLoginUserMessage.classList.remove('hidden');
      createLoginUserMessage.classList.remove('text-red-400');
      createLoginUserMessage.classList.add('text-green-400');

      // Clear inputs
      document.getElementById('loginName').value = '';
      document.getElementById('loginEmail').value = '';
      document.getElementById('loginPassword').value = '';
      document.getElementById('loginReportingManager').value = '';
    } catch (err) {
      console.error('[CREATE LOGIN USER] error:', err);
      createLoginUserMessage.textContent =
        err.message || 'Error creating login user.';
      createLoginUserMessage.classList.remove('hidden');
      createLoginUserMessage.classList.remove('text-green-400');
      createLoginUserMessage.classList.add('text-red-400');
    } finally {
      createLoginUserButton.disabled = false;
      createLoginUserButton.textContent = 'Create Login User';
    }
  });
}

// ================= Assign Users: Inline Edit Helpers (mapped table) =================

function escapeHtmlInline(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// Build clinic options HTML once
function buildClinicOptionsHtml(selectedClinicId) {
  const clinics = Array.isArray(userFormDynamicOptions.clinics)
    ? userFormDynamicOptions.clinics
    : [];

  const opts = ['<option value="">Select Clinic</option>'];

  clinics.forEach((c) => {
    const id = c.id;
    const name = c.name || c.clinic || `Clinic ${id}`;
    const selected = String(id) === String(selectedClinicId) ? 'selected' : '';
    opts.push(`<option value="${escapeHtmlInline(id)}" ${selected}>${escapeHtmlInline(name)}</option>`);
  });

  return opts.join('');
}

// Providers filtered using the SAME logic as top dropdown: clinic_id / clinicId
function buildProviderOptionsHtml(selectedClinicId, selectedProviderId) {
  const providersAll = Array.isArray(assignUsersOptions.providers)
    ? assignUsersOptions.providers
    : [];

  const clinicId = selectedClinicId;
  if (!clinicId) {
    return `<option value="">Select clinic first</option>`;
  }

  // Determine if backend actually sends clinic info at all (same as top dropdown)
  const providerHasClinicInfo = providersAll.some((p) => {
    const provClinicId = p.clinic_id ?? p.clinicId;
    return provClinicId != null;
  });

  let providers = providersAll.filter((p) => {
    const provClinicId = p.clinic_id ?? p.clinicId;
    if (provClinicId == null) return false;
    return String(provClinicId) === String(clinicId);
  });

  // Fallback ONLY if backend didn't send any clinic_id for providers
  if (!providers.length && !providerHasClinicInfo && providersAll.length) {
    // No clinic info at all → can't filter → show all providers
    providers = providersAll;
  }


  // If clinic not selected yet
  if (!clinicId) {
    return `<option value="">Select clinic first</option>`;
  }

  // If no providers for clinic
  if (!providers.length) {
    return `<option value="">No providers for this clinic</option>`;
  }

  const opts = ['<option value="">Select Provider</option>'];

  providers.forEach((p) => {
    const pid = p.id;
    const selected = String(pid) === String(selectedProviderId) ? 'selected' : '';
    opts.push(`<option value="${escapeHtmlInline(pid)}" ${selected}>${escapeHtmlInline(formatUserDropdownLabel(p))}</option>`);
  });

  return opts.join('');
}


async function loadAssignUsersTable() {
  try {
    const response = await fetch('/api/platform/scribe-provider-mapping', {
      method: 'GET',
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error('Failed to load mappings');
    }

    const data = await response.json();

    if (!data.ok) {
      throw new Error(data.message || 'Failed to load mappings');
    }

    const mappings = Array.isArray(data.mappings) ? data.mappings : [];
    const tableBody = document.getElementById('assignUsersTable');
    if (!tableBody) return;

    // ✅ Scribe filter
    const scribeSelect = document.getElementById('assignScribeFilter'); // <-- confirm this id in HTML
    const selectedScribeId = scribeSelect ? scribeSelect.value : '';

    // ✅ All scribes visible to this user (Manager vs SuperAdmin is already handled by backend)
    const allScribes = Array.isArray(assignUsersOptions?.scribes) ? assignUsersOptions.scribes : [];

    // ✅ Build a set of scribes that have at least one mapping
    const mappedScribeIdSet = new Set(
      mappings
        .map((m) => {
          const sObjId = m.scribe && (m.scribe.id ?? m.scribe.user_id);
          const sFlatId = m.scribe_user_id ?? m.scribeId ?? m.scribe_userId;
          return String(sObjId ?? sFlatId ?? '');
        })
        .filter(Boolean)
    );

    // ✅ Filter mapped rows (top table)
    let filteredMappings = mappings;

    if (selectedScribeId) {
      filteredMappings = mappings.filter((m) => {
        const sObjId = m.scribe && (m.scribe.id ?? m.scribe.user_id);
        const sFlatId = m.scribe_user_id ?? m.scribeId ?? m.scribe_userId;
        const effectiveScribeId = sObjId ?? sFlatId;
        return String(effectiveScribeId) === String(selectedScribeId);
      });
    }

    // ✅ Filter unmapped scribes (bottom table)
    let unmappedScribes = allScribes.filter((s) => {
      const sid = s.id ?? s.user_id;
      return sid != null && !mappedScribeIdSet.has(String(sid));
    });

    if (selectedScribeId) {
      unmappedScribes = unmappedScribes.filter(
        (s) => String(s.id ?? s.user_id) === String(selectedScribeId)
      );
    }

    // --- 2) Render unmapped section BELOW mapped table ---
    const mappedTable = tableBody.closest('table');
    if (mappedTable) {
      // Create (or reuse) a container right after the mapped table
      let unmappedWrap = document.getElementById('unmappedScribesWrap');

      if (!unmappedWrap) {
        unmappedWrap = document.createElement('div');
        unmappedWrap.id = 'unmappedScribesWrap';
        unmappedWrap.className = 'mt-6';
        mappedTable.insertAdjacentElement('beforebegin', unmappedWrap);
      }

      if (!unmappedScribes.length) {
        unmappedWrap.innerHTML = `
          <div class="text-sm text-gray-500 mt-2">
            No unmapped scribes found.
          </div>
        `;
      } else {
        const ASSIGN_USERS_SCREEN_ID = 8;
        const canWrite = canScreen(ASSIGN_USERS_SCREEN_ID, 'write');

        unmappedWrap.innerHTML = `
          <div class="text-white font-semibold mb-2">Unmapped Scribes</div>
          <div class="overflow-x-auto">
            <table class="w-full text-left border-collapse">
              <thead>
                <tr class="text-gray-400 border-b border-gray-700">
                  <th class="py-2">Scribe Name</th>
                  <th class="py-2">Scribe Email</th>
                  <th class="py-2">Scribe XR ID</th>
                  <th class="py-2">Scribe Manager</th>
                  <th class="py-2">Clinic</th>
                  <th class="py-2">Provider</th>
                  <th class="py-2 text-right">Action</th>
                </tr>
              </thead>
              <tbody id="unmappedScribesTbody">
                ${unmappedScribes
            .map((s) => {
              const sid = s.id ?? s.user_id;
              const sName = escapeHtmlInline(s.name || s.full_name || 'N/A');
              const sEmail = escapeHtmlInline(s.email || 'N/A');
              const sXrId = escapeHtmlInline(s.xrId || s.xr_id || 'N/A');
              const sManager = escapeHtmlInline(
                s.managerName || s.manager_name || s.manager || 'N/A'
              );

              return `
                      <tr class="border-b border-gray-800" data-unmapped-scribe-id="${escapeHtmlInline(sid)}">
                        <td class="py-3 text-sm">${sName}</td>
                        <td class="py-3 text-sm">${sEmail}</td>
                        <td class="py-3 text-sm">${sXrId}</td>
                        <td class="py-3 text-sm">${sManager}</td>

                        <td class="py-3">
                          <select class="unmapped-clinic px-2 py-1 rounded bg-gray-700 border border-gray-600 text-white text-xs"
                                  ${canWrite ? '' : 'disabled'}>
                            ${buildClinicOptionsHtml('')}
                          </select>
                        </td>

                        <td class="py-3">
                          <select class="unmapped-provider px-2 py-1 rounded bg-gray-700 border border-gray-600 text-white text-xs"
                                  disabled
                                  ${canWrite ? '' : 'disabled'}>
                            <option value="">Select clinic first</option>
                          </select>
                        </td>

                        <td class="py-3 text-right whitespace-nowrap">
                          <button class="unmapped-save px-3 py-1 rounded bg-green-600 hover:bg-green-700 text-white text-xs shrink-0"
                                  ${canWrite ? '' : 'disabled'}>
                            Save
                          </button>
                        </td>
                      </tr>
                    `;
            })
            .join('')}
              </tbody>
            </table>
          </div>
        `;

        const unmappedTbody = document.getElementById('unmappedScribesTbody');
        if (unmappedTbody && !unmappedTbody.dataset.bound) {
          unmappedTbody.dataset.bound = '1';

          // clinic -> provider cascade
          unmappedTbody.addEventListener('change', (e) => {
            const clinicSel = e.target.closest('.unmapped-clinic');
            if (!clinicSel) return;

            const row = clinicSel.closest('tr[data-unmapped-scribe-id]');
            if (!row) return;

            const providerSel = row.querySelector('.unmapped-provider');
            if (!providerSel) return;

            const clinicId = clinicSel.value;
            providerSel.innerHTML = buildProviderOptionsHtml(clinicId, '');
            const hasValidOptions = providerSel.querySelectorAll('option').length > 1;
            providerSel.disabled = !clinicId || !hasValidOptions;
          });

          // Save mapping
          unmappedTbody.addEventListener('click', async (e) => {
            const btn = e.target.closest('.unmapped-save');
            if (!btn) return;

            const row = btn.closest('tr[data-unmapped-scribe-id]');
            if (!row) return;

            const scribeId = row.getAttribute('data-unmapped-scribe-id');
            const providerSel = row.querySelector('.unmapped-provider');
            const providerId = providerSel ? providerSel.value : '';

            const scribeIdNum = Number(scribeId);
            const providerIdNum = Number(providerId);

            if (!Number.isFinite(scribeIdNum) || !Number.isFinite(providerIdNum) || providerIdNum <= 0) {
              showToast('Please select Clinic and Provider before saving.', 'error');
              return;
            }

            try {
              btn.disabled = true;
              btn.textContent = 'Saving...';

              const res = await fetch('/api/platform/scribe-provider-mapping', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                  scribeUserId: scribeIdNum,
                  providerUserId: providerIdNum,
                }),
              });

              const out = await res.json().catch(() => ({}));
              if (!res.ok || !out.ok) throw new Error(out.message || 'Failed to save assignment');

              showToast(out.message || 'Assignment saved', 'success');

              // refresh mapped + unmapped
              await loadAssignUsersTable();
            } catch (err) {
              console.error('Unmapped save error:', err);
              showToast(err.message || 'Failed to save assignment', 'error');
            } finally {
              btn.disabled = !canScreen(ASSIGN_USERS_SCREEN_ID, 'write');
              btn.textContent = 'Save';
            }
          });
        }
      }
    }



    // --- 1) Render mapped section (existing table) ---
    // ✅ ADD THIS BLOCK (Mapped Scribes heading)
    const mappedTableEl = tableBody.closest('table');
    if (mappedTableEl && !document.getElementById('mappedScribesHeading')) {
      const heading = document.createElement('div');
      heading.id = 'mappedScribesHeading';
      heading.className = 'text-white font-semibold mb-2 mt-6';
      heading.textContent = 'Mapped Scribes';

      mappedTableEl.insertAdjacentElement('beforebegin', heading);
    }
    if (!filteredMappings.length) {
      tableBody.innerHTML = `
        <tr>
          <td colspan="9" class="py-8 text-center text-gray-500">
            ${selectedScribeId ? 'No provider assigned to this scribe.' : 'No mapped assignments found.'}
          </td>
        </tr>
      `;
      // ✅ DO NOT return here (we still render Unmapped below)
    }

    if (filteredMappings.length) {
      tableBody.innerHTML = filteredMappings
        .map((m) => {
          const s = m.scribe || {};
          const p = m.provider || {};

          // ✅ Always compute ids safely (API may return flat or nested ids)
          const effectiveScribeId =
            s.id ?? s.user_id ?? m.scribe_user_id ?? m.scribeId ?? m.scribe_userId ?? '';

          const effectiveProviderId =
            p.id ?? m.provider_user_id ?? m.providerId ?? m.provider_userId ?? '';

          const sName = s.name || s.full_name || 'N/A';
          const sEmail = s.email || 'N/A';
          const sXrId = s.xrId || s.xr_id || 'N/A';

          const pXrId = p.xrId || p.xr_id || 'N/A';
          const pName = p.name || p.full_name || 'N/A';
          const pEmail = p.email || 'N/A';

          const managerName = s.managerName || s.manager_name || 'N/A';

          // Defaults for inline edit controls
          const currentClinicId = p.clinic_id ?? p.clinicId ?? '';
          const currentProviderId = effectiveProviderId;

          // Clinic display text (from clinics list if available)
          const clinicObj = (userFormDynamicOptions?.clinics || []).find(
            (c) => String(c.id) === String(currentClinicId)
          );
          const clinicName =
            clinicObj?.clinic ||
            clinicObj?.name ||
            p.clinic_name ||
            p.clinicName ||
            'N/A';

          const ASSIGN_USERS_SCREEN_ID = 8;
          const canWrite = canScreen(ASSIGN_USERS_SCREEN_ID, 'write');

          return `
            <tr class="table-row border-b border-gray-700"
                data-mapping-id="${escapeHtmlInline(m.id)}"
                data-scribe-id="${escapeHtmlInline(effectiveScribeId)}"
                data-orig-clinic-id="${escapeHtmlInline(currentClinicId)}"
                data-orig-provider-id="${escapeHtmlInline(effectiveProviderId)}">

              <td class="py-3">${escapeHtmlInline(sName)}</td>

              <!-- 2) Scribe Email -->
              <td class="py-3 text-sm">${escapeHtmlInline(sEmail)}</td>

              <!-- 3) Scribe XR ID -->
              <td class="py-3">
                <span class="px-2 py-1 text-xs rounded-full bg-blue-500 bg-opacity-20 text-blue-400">
                  ${escapeHtmlInline(sXrId)}
                </span>
              </td>

              <!-- 4) Provider XR ID (DISPLAY) -->
              <td class="py-3">
                <span class="px-2 py-1 text-xs rounded-full bg-blue-500 bg-opacity-20 text-blue-400">
                  ${escapeHtmlInline(pXrId)}
                </span>
              </td>

              <!-- 5) Clinic (VIEW default, EDIT dropdown hidden) -->
              <td class="py-3">
                <span class="assign-view-clinic text-sm">${escapeHtmlInline(clinicName)}</span>

                <select class="assign-inline-clinic hidden px-2 py-1 rounded bg-gray-700 border border-gray-600 text-white text-xs"
                        ${canWrite ? '' : 'disabled'}
                        title="${canWrite ? '' : 'Read-only access'}">
                  ${buildClinicOptionsHtml(currentClinicId)}
                </select>
              </td>

              <!-- 6) Provider Name (VIEW default, EDIT dropdown hidden) -->
              <td class="py-3">
                <span class="assign-view-provider">${escapeHtmlInline(pName)}</span>

                <select class="assign-inline-provider hidden px-2 py-1 rounded bg-gray-700 border border-gray-600 text-white text-xs"
                        ${canWrite ? '' : 'disabled'}
                        title="${canWrite ? '' : 'Read-only access'}">
                  ${buildProviderOptionsHtml(currentClinicId, currentProviderId)}
                </select>
              </td>

              <!-- 7) Provider Email (DISPLAY) -->
              <td class="py-3 text-sm">${escapeHtmlInline(pEmail)}</td>

              <!-- 8) Scribe Manager -->
              <td class="py-3 text-sm">${escapeHtmlInline(managerName)}</td>

              <!-- 9) Actions -->
              <td class="py-3 text-sm whitespace-nowrap">
                <div class="flex items-center gap-2 justify-end">
                  <button class="assign-inline-edit px-2 py-1 rounded bg-blue-600 hover:bg-blue-700 text-white text-xs"
                          ${canWrite ? '' : 'disabled'}>
                    Edit
                  </button>

                  <button class="assign-inline-save hidden px-2 py-1 rounded bg-green-600 hover:bg-green-700 text-white text-xs"
                          ${canWrite ? '' : 'disabled'}>
                    Save
                  </button>

                  <button class="assign-inline-cancel hidden px-2 py-1 rounded bg-gray-600 hover:bg-gray-700 text-white text-xs"
                          ${canWrite ? '' : 'disabled'}>
                    Cancel
                  </button>
                </div>
              </td>
            </tr>
          `;
        })
        .join('');
    }

    // Avoid stacking listeners (simple guard)
    if (!tableBody.dataset.inlineEditBound) {
      tableBody.dataset.inlineEditBound = '1';

      // When clinic changes in a row (in edit mode), rebuild provider dropdown for that clinic
      tableBody.addEventListener('change', (e) => {
        const clinicSelect = e.target.closest('.assign-inline-clinic');
        if (!clinicSelect) return;

        const row = clinicSelect.closest('tr[data-scribe-id]');
        if (!row) return;

        const providerSelect = row.querySelector('.assign-inline-provider');
        if (!providerSelect) return;

        const clinicId = clinicSelect.value;

        providerSelect.innerHTML = buildProviderOptionsHtml(clinicId, '');
        const hasValidOptions = providerSelect.querySelectorAll('option').length > 1;
        providerSelect.disabled = !clinicId || !hasValidOptions;
      });

      tableBody.addEventListener('click', async (e) => {
        // EDIT mode toggle
        const editBtn = e.target.closest('.assign-inline-edit');
        if (editBtn) {
          const ASSIGN_USERS_SCREEN_ID = 8;
          if (!canScreen(ASSIGN_USERS_SCREEN_ID, 'write')) {
            showToast('You only have READ permission for Assign Users. Editing is not allowed.', 'error');
            return;
          }

          const row = editBtn.closest('tr[data-scribe-id]');
          if (!row) return;

          // Hide view spans
          row
            .querySelectorAll('.assign-view-clinic, .assign-view-provider')
            .forEach((el) => el.classList.add('hidden'));

          // Show selects + save/cancel
          const clinicSelect = row.querySelector('.assign-inline-clinic');
          const providerSelect = row.querySelector('.assign-inline-provider');
          const saveBtn = row.querySelector('.assign-inline-save');
          const cancelBtn = row.querySelector('.assign-inline-cancel');

          if (clinicSelect) clinicSelect.classList.remove('hidden');
          if (providerSelect) providerSelect.classList.remove('hidden');
          if (saveBtn) saveBtn.classList.remove('hidden');
          if (cancelBtn) cancelBtn.classList.remove('hidden');

          // Hide edit
          editBtn.classList.add('hidden');
          return;
        }

        // CANCEL edit mode (revert to original)
        const cancelBtn = e.target.closest('.assign-inline-cancel');
        if (cancelBtn) {
          const row = cancelBtn.closest('tr[data-scribe-id]');
          if (!row) return;

          const origClinicId = row.getAttribute('data-orig-clinic-id') || '';
          const origProviderId = row.getAttribute('data-orig-provider-id') || '';

          const clinicSelect = row.querySelector('.assign-inline-clinic');
          const providerSelect = row.querySelector('.assign-inline-provider');

          if (clinicSelect) clinicSelect.value = origClinicId;
          if (providerSelect) providerSelect.innerHTML = buildProviderOptionsHtml(origClinicId, origProviderId);

          // Hide selects + save/cancel
          row
            .querySelectorAll(
              '.assign-inline-clinic, .assign-inline-provider, .assign-inline-save, .assign-inline-cancel'
            )
            .forEach((el) => el.classList.add('hidden'));

          // Show view spans
          row
            .querySelectorAll('.assign-view-clinic, .assign-view-provider')
            .forEach((el) => el.classList.remove('hidden'));

          // Show edit
          const editBtn = row.querySelector('.assign-inline-edit');
          if (editBtn) editBtn.classList.remove('hidden');

          return;
        }

        // SAVE mapping update
        const saveBtn = e.target.closest('.assign-inline-save');
        if (!saveBtn) return;

        const ASSIGN_USERS_SCREEN_ID = 8;
        if (!canScreen(ASSIGN_USERS_SCREEN_ID, 'write')) {
          showToast('You only have READ permission for Assign Users. Editing is not allowed.', 'error');
          return;
        }

        const row = saveBtn.closest('tr[data-scribe-id]');
        if (!row) return;

        const scribeId = row.getAttribute('data-scribe-id');
        const providerSelect = row.querySelector('.assign-inline-provider');
        const providerId = providerSelect ? providerSelect.value : '';

        if (!scribeId || !providerId) {
          showToast('Please select a Clinic and Provider before saving.', 'error');
          return;
        }

        try {
          saveBtn.disabled = true;
          saveBtn.textContent = 'Saving...';

          const res = await fetch('/api/platform/scribe-provider-mapping', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
              scribeUserId: Number(scribeId),
              providerUserId: Number(providerId),
            }),
          });

          const out = await res.json();
          if (!res.ok || !out.ok) throw new Error(out.message || 'Failed to update mapping');

          showToast('Mapping updated', 'success');

          // Reload table to reflect changes & return to view mode
          await loadAssignUsersTable();
        } catch (err) {
          console.error('Inline save mapping error:', err);
          showToast(err.message || 'Failed to update mapping', 'error');
        } finally {
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save';
        }
      });
    }
  } catch (err) {
    console.error('Failed to load mappings:', err);
    showToast('Failed to load mappings', 'error');
  }
}




// Legacy assignment function (deprecated). Disabled to prevent mixing endpoints.
window.saveAssignment = async function () {
  console.warn('saveAssignment() is deprecated. Use /api/platform/scribe-provider-mapping flow.');
  showToast('This action is deprecated. Use Assign Users mapping screen.', 'error');
};


checkSession();

// ================= PROFILE PANEL EVENT LISTENERS =================
window.addEventListener('load', () => {
  const profileButton = document.getElementById('profileButton');
  const profilePanel = document.getElementById('profilePanel');
  const closeProfile = document.getElementById('closeProfile');

  if (profileButton && profilePanel && closeProfile) {
    profileButton.addEventListener('click', () => {
      loadProfileData();
      profilePanel.classList.remove('hidden');
    });

    closeProfile.addEventListener('click', () => {
      profilePanel.classList.add('hidden');
    });
  }
});
