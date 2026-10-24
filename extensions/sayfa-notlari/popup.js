const notes = document.getElementById('notes');
const saved = document.getElementById('saved');

notes.value = localStorage.getItem('quick_notes') || '';
notes.addEventListener('input', () => {
  localStorage.setItem('quick_notes', notes.value);
  saved.style.opacity = '1';
  setTimeout(() => saved.style.opacity = '0', 1000);
});
